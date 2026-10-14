package bnoc

import jakarta.annotation.PostConstruct
import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.UUID

@Service
class AuthService(val db:Database,
    @param:Value("\${bnoc.integration-mode}") val mode:String,
    @param:Value("\${bnoc.provider-url}") val providerUrl:String,
    @param:Value("\${bnoc.provider-secret}") val secret:String,
    @param:Value("\${bnoc.public-url}") val publicUrl:String) {
    val client:HttpClient=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build()
    val origin:String=originOf(publicUrl) ?: error("공개 서비스 주소를 확인하세요.")
    @PostConstruct fun validate() {
        check(mode=="competition") { "운영 모드에는 실제 인증·정보 연결 구현이 필요합니다. 모의 연결로 시작하지 않습니다." }
        check(secret.length>=24) { "BNOC_MOCK_SECRET에는 24자 이상의 시연 연결 비밀값이 필요합니다." }
        val provider=URI(providerUrl)
        check(provider.host in listOf("127.0.0.1","localhost","::1") && provider.scheme in listOf("http","https") && provider.userInfo==null) { "대회용 모의 제공자는 로컬 주소만 허용합니다." }
        val url=URI(publicUrl)
        check(url.scheme=="https" || (url.scheme=="http" && url.host in listOf("127.0.0.1","localhost","::1"))) { "공개 서비스는 HTTPS가 필요합니다. HTTP는 로컬 시연만 허용합니다." }
        check(url.path.isNullOrEmpty() || url.path=="/") { "공개 서비스 주소는 경로 없는 Origin이어야 합니다." }
    }
    fun csrf(request:HttpServletRequest):String {
        val session=request.getSession(true);session.maxInactiveInterval=1800
        return (session.getAttribute("csrf") as? String) ?: UUID.randomUUID().toString().also { session.setAttribute("csrf",it) }
    }
    fun actor(request:HttpServletRequest):Actor? {
        val session=request.getSession(false) ?: return null
        val subject=session.getAttribute("subject") as? String ?: return null
        val authenticated=session.getAttribute("authenticatedAt") as? Instant
        if(authenticated==null || !Instant.now().isBefore(authenticated.plusSeconds(8*3600))) { session.invalidate();return null }
        return db.actor(subject)?.takeIf { it.active }
    }
    fun start(request:HttpServletRequest):Map<String,Any> {
        val session=request.getSession(true);session.maxInactiveInterval=1800
        val attempt=UUID.randomUUID().toString();val binding=UUID.randomUUID().toString()
        session.setAttribute("loginAttempt",attempt);session.setAttribute("browserBinding",binding);session.setAttribute("loginExpires",Instant.now().plusSeconds(300))
        fun enc(value:String)=URLEncoder.encode(value,Charsets.UTF_8)
        return mapOf("loginAttempt" to attempt,"providerUrl" to "$origin/identity?loginAttempt=${enc(attempt)}&browserBinding=${enc(binding)}&returnUrl=${enc("$origin/auth/callback")}","csrfToken" to csrf(request),"sourceMode" to "simulation")
    }
    fun proxyIdentity(request:HttpServletRequest):ResponseEntity<ByteArray> {
        if(request.requestURI!="/identity") return identityError(404,"NOT_FOUND")
        if(request.method !in listOf("GET","POST")) return identityError(405,"FORBIDDEN")
        val target=runCatching { URI("${URI(providerUrl).resolve("/identity")}${request.queryString?.let { "?$it" } ?: ""}") }.getOrElse { return identityError(400,"VALIDATION") }
        if(target.rawFragment!=null) return identityError(400,"VALIDATION")
        val upstream=HttpRequest.newBuilder(target).timeout(Duration.ofSeconds(5))
        if(request.method=="POST") {
            if(request.getHeader("Origin")!=origin) return identityError(403,"FORBIDDEN")
            val form=runCatching { MediaType.parseMediaType(request.contentType.orEmpty()).let { it.type.equals("application",true) && it.subtype.equals("x-www-form-urlencoded",true) } }.getOrDefault(false)
            if(!form) return identityError(415,"VALIDATION")
            if(request.contentLengthLong>64*1024) return identityError(413,"VALIDATION")
            val body=runCatching { request.inputStream.readNBytes(64*1024+1) }.getOrElse { return identityError(400,"VALIDATION") }
            if(body.size>64*1024) return identityError(413,"VALIDATION")
            upstream.header("Content-Type","application/x-www-form-urlencoded").POST(HttpRequest.BodyPublishers.ofByteArray(body))
        } else upstream.GET()
        val response=runCatching { client.send(upstream.build(),HttpResponse.BodyHandlers.ofByteArray()) }.getOrElse { return identityError(503,"AUTH_PROVIDER_UNAVAILABLE") }
        val status=response.statusCode()
        if(status<200 || status in 300..399 || status>=500) return identityError(503,"AUTH_PROVIDER_UNAVAILABLE")
        val headers=HttpHeaders()
        for(name in listOf("Content-Type","Content-Security-Policy","Cache-Control","X-Content-Type-Options")) {
            val values=response.headers().allValues(name)
            if(values.isNotEmpty()) headers.addAll(name,values)
        }
        return ResponseEntity.status(status).headers(headers).body(response.body())
    }
    private fun identityError(status:Int,code:String):ResponseEntity<ByteArray> {
        val response=ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff")
        if(status==405) response.header("Allow","GET, POST")
        return response.body(db.json.writeValueAsBytes(mapOf("code" to code,"message" to messageFor(code))))
    }
    fun complete(request:HttpServletRequest,payload:Map<String,Any?>):Map<String,Any> {
        if(payload.keys.any { it !in setOf("ticket","loginAttempt") }) reject("VALIDATION")
        val session=request.getSession(false) ?: reject("FORBIDDEN")
        val attempt=session.getAttribute("loginAttempt") as? String ?: reject("FORBIDDEN")
        val expires=session.getAttribute("loginExpires") as? Instant ?: reject("FORBIDDEN")
        val binding=session.getAttribute("browserBinding") as? String ?: reject("FORBIDDEN")
        val ticket=payload["ticket"] as? String
        if(payload["loginAttempt"]!=attempt || !Instant.now().isBefore(expires) || ticket.isNullOrBlank() || ticket.length>1024) reject("FORBIDDEN")
        val proof=mapOf("ticket" to ticket,"loginAttempt" to attempt,"browserBinding" to binding)
        val response=runCatching { client.send(HttpRequest.newBuilder(URI("$providerUrl/identity/verify")).timeout(Duration.ofSeconds(5)).header("X-Mock-Key",secret).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(db.json.writeValueAsString(proof))).build(),HttpResponse.BodyHandlers.ofString()) }.getOrElse { reject("AUTH_PROVIDER_UNAVAILABLE") }
        if(response.statusCode()>=500) reject("AUTH_PROVIDER_UNAVAILABLE")
        if(response.statusCode()!=200) reject("FORBIDDEN")
        val data=runCatching { db.json.readValue(response.body(),Map::class.java) }.getOrElse { reject("FORBIDDEN") }
        if(data["sourceMode"]!="simulation") reject("FORBIDDEN")
        val subject=data["subject"] as? String ?: reject("FORBIDDEN")
        val actor=db.actor(subject)?.takeIf { it.active } ?: reject("FORBIDDEN")
        synchronized(session) {
            if(session.getAttribute("loginAttempt")!=attempt) reject("FORBIDDEN")
            session.removeAttribute("loginAttempt");session.removeAttribute("browserBinding");session.removeAttribute("loginExpires")
            request.changeSessionId();session.setAttribute("subject",actor.id);session.setAttribute("authenticatedAt",Instant.now());session.setAttribute("csrf",UUID.randomUUID().toString())
        }
        return mapOf("ok" to true)
    }
    companion object {
        fun originOf(value:String):String?=runCatching { URI(value).let { uri -> if(uri.scheme !in listOf("http","https") || uri.host==null || uri.userInfo!=null) null else "${uri.scheme.lowercase()}://${uri.host.lowercase()}${if(uri.port==-1 || (uri.scheme=="http" && uri.port==80) || (uri.scheme=="https" && uri.port==443)) "" else ":${uri.port}"}" } }.getOrNull()
    }
}
