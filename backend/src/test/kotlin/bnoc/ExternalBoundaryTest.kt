package bnoc

import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.mock.web.MockHttpServletRequest
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLDecoder
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.Executors

class ExternalBoundaryTest {
    lateinit var db:Database
    lateinit var auth:AuthService
    lateinit var tx:TransactionTemplate
    lateinit var server:HttpServer
    val gps=AtomicReference<Map<String,Any?>>()
    val cpcon=AtomicReference<Map<String,Any?>>()
    val proof=AtomicReference<Map<String,Any?>>()
    var failCpcon=false
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize();tx=TransactionTemplate(DataSourceTransactionManager(source))
        server=HttpServer.create(InetSocketAddress("127.0.0.1",0),0)
        for(kind in listOf("gps","cpcon")) server.createContext("/feeds/$kind") { exchange ->
            val json=db.json.writeValueAsBytes(if(kind=="gps") gps.get() else cpcon.get())
            exchange.sendResponseHeaders(if(kind=="cpcon" && failCpcon) 503 else 200,json.size.toLong());exchange.responseBody.use { it.write(json) }
        }
        server.createContext("/identity/verify") { exchange ->
            val input=db.json.readValue(exchange.requestBody,Map::class.java)
            val expected=proof.getAndSet(null)
            val valid=expected!=null && input==expected && exchange.requestHeaders.getFirst("X-Mock-Key")==auth.secret
            val body=db.json.writeValueAsBytes(if(valid) mapOf("subject" to "requester","sourceMode" to "simulation") else mapOf("code" to "FORBIDDEN"))
            exchange.sendResponseHeaders(if(valid) 200 else 403,body.size.toLong());exchange.responseBody.use { it.write(body) }
        }
        server.start()
        auth=AuthService(db,"competition","http://127.0.0.1:${server.address.port}","12345678901234567890123456789012","http://127.0.0.1:8081");auth.validate()
        gps.set(feed("gps","5"));cpcon.set(feed("cpcon","3"));failCpcon=false
    }
    @AfterEach fun cleanup() { server.stop(0) }
    private fun feed(kind:String,code:String,observed:Instant=Instant.now()):Map<String,Any?> = mapOf("kind" to kind,"scopeKey" to if(kind=="gps") "unit" else "source","sourceMode" to "simulation","stageCode" to code,"stageLabel" to if(kind=="gps") if(code=="5") "양호" else "${code}단계" else "CPCON${mapOf("1" to "Ⅰ","2" to "Ⅱ","3" to "Ⅲ","4" to "Ⅳ","5" to "Ⅴ")[code]}급","observedAt" to observed.toString())
    private fun situations(codes:String="1,2,3,4,5")=SituationService(db,auth,tx,30000,30000,5000,5000,120,120,codes).also { it.validate() }
    @Test fun `independent feeds preserve last successful CPCON while GPS still succeeds`() {
        val service=situations();service.collectGps();service.collectCpcon()
        assertEquals("양호",service.snapshot("gps")["stageLabel"]);assertEquals("CPCONⅢ급",service.snapshot("cpcon")["stageLabel"])
        val last=service.snapshot("cpcon")["lastSuccess"]
        failCpcon=true;service.collectCpcon();gps.set(feed("gps","2"));service.collectGps()
        assertEquals("2",service.snapshot("gps")["stageCode"]);assertEquals("ok",service.snapshot("gps")["collectionState"])
        assertEquals("failed",service.snapshot("cpcon")["collectionState"]);assertEquals("3",service.snapshot("cpcon")["stageCode"]);assertEquals(last,service.snapshot("cpcon")["lastSuccess"])
    }
    @Test fun `first failure is failed stale is stale future and unknown stages are rejected`() {
        val service=situations();assertEquals("not_collected",service.snapshot("cpcon")["collectionState"])
        failCpcon=true;service.collectCpcon();assertEquals("failed",service.snapshot("cpcon")["collectionState"]);assertNotNull(service.snapshot("cpcon")["lastAttempt"]);assertNull(service.snapshot("cpcon")["lastSuccess"])
        gps.set(feed("gps","5",Instant.now().minusSeconds(300)));service.collectGps();assertEquals("stale",service.snapshot("gps")["collectionState"])
        val last=service.snapshot("gps")["lastSuccess"]
        gps.set(feed("gps","5",Instant.now().plusSeconds(120)));service.collectGps();assertEquals("FUTURE_OBSERVED_AT",service.snapshot("gps")["failureCode"]);assertEquals(last,service.snapshot("gps")["lastSuccess"])
        gps.set(feed("gps","9"));service.collectGps();assertEquals("INVALID_STAGE",service.snapshot("gps")["failureCode"])
    }
    @Test fun `missing CPCON dictionary is unconfigured and operational mock is rejected`() {
        val service=situations("");service.collectCpcon();assertEquals("unconfigured",service.snapshot("cpcon")["collectionState"])
        assertThrows(IllegalStateException::class.java) { AuthService(db,"operational",auth.providerUrl,auth.secret,auth.publicUrl).validate() }
    }
    @Test fun `browser login stays on configured service origin for local and public demonstrations`() {
        for(publicUrl in listOf("http://127.0.0.1:8081","https://bnoc.example")) {
            val service=AuthService(db,"competition",auth.providerUrl,auth.secret,publicUrl).also { it.validate() }
            val request=MockHttpServletRequest().also { it.addHeader("Host","attacker.example");it.addHeader("X-Forwarded-Host","attacker.example") }
            val challenge=service.start(request)
            val location=URI(challenge["providerUrl"] as String)
            assertEquals(service.origin,AuthService.originOf(location.toString()),"BNOC_IDENTITY_MUST_USE_SERVICE_ORIGIN")
            assertEquals("/identity",location.path)
            val query=location.rawQuery.split('&').associate { part -> part.split('=',limit=2).let { it[0] to URLDecoder.decode(it[1],Charsets.UTF_8) } }
            assertEquals("${service.origin}/auth/callback",query["returnUrl"])
            assertEquals(challenge["loginAttempt"],query["loginAttempt"])
            assertEquals(request.getSession(false)!!.getAttribute("browserBinding"),query["browserBinding"])
        }
    }
    @Test fun `identity completion binds starting browser attempt consumes proof and absolute expiry`() {
        val request=MockHttpServletRequest();val start=auth.start(request)
        val attempt=start["loginAttempt"] as String;val session=request.getSession(false)!!;val binding=session.getAttribute("browserBinding") as String
        proof.set(mapOf("ticket" to "valid-proof","loginAttempt" to attempt,"browserBinding" to binding))
        val stranger=MockHttpServletRequest();auth.start(stranger)
        assertThrows(BusinessFailure::class.java) { auth.complete(stranger,mapOf("ticket" to "valid-proof","loginAttempt" to attempt)) }
        assertTrue(auth.complete(request,mapOf("ticket" to "valid-proof","loginAttempt" to attempt))["ok"]==true)
        assertEquals("requester",auth.actor(request)!!.id)
        assertThrows(BusinessFailure::class.java) { auth.complete(request,mapOf("ticket" to "valid-proof","loginAttempt" to attempt)) }
        request.getSession(false)!!.setAttribute("authenticatedAt",Instant.now().minusSeconds(8*3600+1))
        assertNull(auth.actor(request))
    }
}
