package bnoc

import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.http.HttpMethod
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.test.web.servlet.setup.StandaloneMockMvcBuilder
import java.net.InetSocketAddress
import java.net.URI
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

class PublicIdentityProxyTest {
    lateinit var auth:AuthService
    lateinit var server:HttpServer
    lateinit var mvc:MockMvc
    private data class UpstreamCall(val method:String,val uri:URI,val headers:Map<String,List<String>>,val body:ByteArray)
    private val calls=CopyOnWriteArrayList<UpstreamCall>()
    private val html="<!doctype html><form method=\"post\" action=\"/identity\"></form>".toByteArray()
    private val policy="default-src 'none'; form-action 'self'; frame-ancestors 'none'"
    private var upstreamStatus=200
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        val db=Database(JdbcTemplate(source));db.initialize()
        server=HttpServer.create(InetSocketAddress("127.0.0.1",0),0)
        server.createContext("/") { exchange ->
            calls.add(UpstreamCall(exchange.requestMethod,exchange.requestURI,exchange.requestHeaders.entries.associate { it.key.lowercase() to it.value.toList() },exchange.requestBody.readAllBytes()))
            for((name,value) in mapOf("Content-Type" to "text/html; charset=UTF-8","Content-Security-Policy" to policy,"Cache-Control" to "no-store","X-Content-Type-Options" to "nosniff","Set-Cookie" to "provider-cookie=private","X-Mock-Key" to "provider-header","X-Internal-Provider" to "private","Location" to "http://127.0.0.1:${server.address.port}/private")) exchange.responseHeaders.add(name,value)
            val body=if(upstreamStatus==200) html else "PRIVATE_UPSTREAM_ERROR".toByteArray()
            exchange.sendResponseHeaders(upstreamStatus,body.size.toLong());exchange.responseBody.use { it.write(body) }
        }
        server.start()
        auth=AuthService(db,"competition","http://127.0.0.1:${server.address.port}","test-mock-secret-at-least-24-characters","https://bnoc.example").also { it.validate() }
        val api=ApiController(auth,db,mock(WorkflowService::class.java),mock(QueryService::class.java),mock(AttachmentService::class.java),mock(SituationService::class.java))
        mvc=MockMvcBuilders.standaloneSetup(PublicIdentityController(api)).setControllerAdvice(ApiErrors()).addFilters<StandaloneMockMvcBuilder>(PublicIdentityBoundaryFilter(api)).build()
    }
    @AfterEach fun cleanup() { server.stop(0) }
    @Test fun `identity GET and same-origin form POST preserve HTML and only safe response headers`() {
        val query="loginAttempt=bound-attempt&browserBinding=bound-browser&returnUrl=https%3A%2F%2Fbnoc.example%2Fauth%2Fcallback&providerUrl=https%3A%2F%2Fattacker.example%2Fidentity%2Fverify"
        val body="subject=requester&$query"
        val responses=listOf(
            mvc.perform(get(URI("/identity?$query")).header("Cookie","browser-session=private").header("X-Mock-Key","browser-header").header("Authorization","Bearer browser-token")).andReturn().response,
            mvc.perform(post("/identity").header("Origin",auth.origin).header("Cookie","browser-session=private").header("X-Mock-Key","browser-header").header("Authorization","Bearer browser-token").contentType("application/x-www-form-urlencoded; charset=UTF-8").content(body)).andReturn().response
        )
        for(response in responses) {
            assertEquals(200,response.status,"BNOC_IDENTITY_PROXY_MUST_SERVE_HTML")
            assertArrayEquals(html,response.contentAsByteArray)
            assertEquals("text/html; charset=UTF-8",response.getHeader("Content-Type"))
            assertEquals(policy,response.getHeader("Content-Security-Policy"))
            assertEquals("no-store",response.getHeader("Cache-Control"));assertEquals("nosniff",response.getHeader("X-Content-Type-Options"))
            for(name in listOf("Set-Cookie","X-Mock-Key","X-Internal-Provider","Location")) assertNull(response.getHeader(name),"BNOC_IDENTITY_MUST_FILTER_RESPONSE_HEADERS:$name")
        }
        assertEquals(listOf("GET","POST"),calls.map { it.method })
        assertTrue(calls.all { it.uri.path=="/identity" && it.uri.isAbsolute.not() },"BNOC_IDENTITY_MUST_CALL_FIXED_ENDPOINT")
        assertEquals(query,calls[0].uri.rawQuery);assertArrayEquals(body.toByteArray(),calls[1].body)
        for(call in calls) for(name in listOf("cookie","x-mock-key","authorization","origin")) assertNull(call.headers[name],"BNOC_IDENTITY_MUST_NOT_FORWARD_BROWSER_HEADERS:$name")
        assertEquals(listOf("application/x-www-form-urlencoded"),calls[1].headers["content-type"])
    }
    @Test fun `only exact GET and POST identity are public`() {
        for(method in listOf("HEAD","OPTIONS","PUT","PATCH","DELETE","TRACE")) {
            val response=mvc.perform(request(HttpMethod.valueOf(method),"/identity")).andReturn().response
            assertEquals(405,response.status,"BNOC_IDENTITY_MUST_REJECT_METHOD:$method")
        }
        for(path in listOf("/identity/","/identity/verify","/identity/issue","/identity/nested/path","/control","/control/nested","/feeds","/feeds/gps","/feeds/cpcon")) {
            for(method in listOf(HttpMethod.GET,HttpMethod.POST,HttpMethod.HEAD,HttpMethod.OPTIONS,HttpMethod.PUT,HttpMethod.DELETE)) {
                val response=mvc.perform(request(method,path).header("Origin",auth.origin).contentType("application/x-www-form-urlencoded").content("subject=requester")).andReturn().response
                assertEquals(404,response.status,"BNOC_IDENTITY_MUST_KEEP_PROVIDER_APIS_PRIVATE:$method $path")
            }
        }
        assertTrue(calls.isEmpty(),"BNOC_IDENTITY_FORBIDDEN_REQUEST_MUST_NOT_REACH_PROVIDER")
    }
    @Test fun `identity and private boundary variants never allow method fallback or upstream access`() {
        val paths=listOf("/identity;probe","/identity%3Bprobe","/%69dentity","/%69dentity/verify","/identity%2Fverify","/control;probe","/control%3Bprobe","/%63ontrol","/feeds;probe/gps","/feeds%3Bprobe/gps","/%66eeds/gps")
        for(path in paths) for(method in listOf(HttpMethod.OPTIONS,HttpMethod.HEAD,HttpMethod.GET,HttpMethod.POST)) {
            val response=mvc.perform(request(method,URI(path)).header("Origin",auth.origin).contentType("application/x-www-form-urlencoded").content("subject=requester")).andReturn().response
            assertTrue(response.status in 400..499,"BNOC_IDENTITY_RAW_BOUNDARY_MUST_BE_REJECTED:$method $path status=${response.status}")
        }
        assertTrue(calls.isEmpty(),"BNOC_IDENTITY_RAW_BOUNDARY_MUST_NOT_REACH_PROVIDER")
    }
    @Test fun `form POST requires exact configured Origin`() {
        for(origin in listOf(null,"null","https://attacker.example","https://bnoc.example/","https://bnoc.example:444")) {
            val request=post("/identity").contentType("application/x-www-form-urlencoded").content("subject=requester")
            if(origin!=null) request.header("Origin",origin)
            assertEquals(403,mvc.perform(request).andReturn().response.status,"BNOC_IDENTITY_POST_MUST_CHECK_ORIGIN")
        }
        assertTrue(calls.isEmpty(),"BNOC_IDENTITY_REJECTED_ORIGIN_MUST_NOT_REACH_PROVIDER")
    }
    @Test fun `form POST rejects other media types and enforces 64 KiB including unknown length`() {
        for(type in listOf("application/json","text/plain","application/x-www-form-urlencoded-extra")) {
            assertEquals(415,mvc.perform(post("/identity").header("Origin",auth.origin).contentType(type).content("subject=requester")).andReturn().response.status)
        }
        assertEquals(415,mvc.perform(post("/identity").header("Origin",auth.origin).content("subject=requester")).andReturn().response.status)
        val large=ByteArray(64*1024+1) { 'x'.code.toByte() }
        assertEquals(413,mvc.perform(post("/identity").header("Origin",auth.origin).contentType("application/x-www-form-urlencoded").content(large)).andReturn().response.status)
        val unknownLength=object:MockHttpServletRequest("POST","/identity") { override fun getContentLengthLong():Long=-1 }.also { it.addHeader("Origin",auth.origin);it.contentType="application/x-www-form-urlencoded";it.setContent(large) }
        assertEquals(413,auth.proxyIdentity(unknownLength).statusCode.value(),"BNOC_IDENTITY_MUST_LIMIT_STREAMED_FORM")
        assertTrue(calls.isEmpty(),"BNOC_IDENTITY_INVALID_FORM_MUST_NOT_REACH_PROVIDER")
        assertEquals(200,mvc.perform(post("/identity").header("Origin",auth.origin).contentType("application/x-www-form-urlencoded").content(large.copyOf(64*1024))).andReturn().response.status)
        assertEquals(64*1024,calls.single().body.size)
    }
    @Test fun `provider failures and redirects return safe 503 without response details`() {
        for(status in listOf(500,503,302,307)) {
            upstreamStatus=status
            val response=mvc.perform(get("/identity")).andReturn().response
            assertEquals(503,response.status,"BNOC_IDENTITY_PROVIDER_FAILURE_MUST_BE_SAFE")
            assertTrue(response.contentAsString.contains("AUTH_PROVIDER_UNAVAILABLE"));assertFalse(response.contentAsString.contains("PRIVATE_UPSTREAM_ERROR"))
            assertNull(response.getHeader("Location"));assertNull(response.getHeader("Set-Cookie"))
        }
        assertEquals(4,calls.size)
    }
    @Test fun `unavailable loopback provider returns safe 503`() {
        server.stop(0)
        val response=mvc.perform(get("/identity")).andReturn().response
        assertEquals(503,response.status);assertTrue(response.contentAsString.contains("AUTH_PROVIDER_UNAVAILABLE"))
        assertFalse(response.contentAsString.contains(auth.providerUrl));assertFalse(response.contentAsString.contains(auth.secret))
    }
}
