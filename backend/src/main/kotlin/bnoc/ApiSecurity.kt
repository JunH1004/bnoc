package bnoc

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.HandlerInterceptor
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.web.multipart.MaxUploadSizeExceededException

@Configuration
class ApiSecurity(private val auth:AuthService):WebMvcConfigurer {
    override fun addInterceptors(registry:InterceptorRegistry) {
        registry.addInterceptor(object:HandlerInterceptor {
            override fun preHandle(request:HttpServletRequest,response:HttpServletResponse,handler:Any):Boolean {
                response.setHeader("Cache-Control","no-store");response.setHeader("X-Content-Type-Options","nosniff")
                if(request.requestURI=="/api/auth/start" && request.method=="GET") return true
                if(request.requestURI!="/api/auth/complete" && auth.actor(request)==null) { error(response,401,"UNAUTHENTICATED");return false }
                if(request.method !in listOf("GET","HEAD","OPTIONS")) {
                    val expected=request.getSession(false)?.getAttribute("csrf") as? String
                    val requestOrigin=request.getHeader("Origin")
                    if(expected==null || expected!=request.getHeader("X-CSRF-Token") || requestOrigin!=auth.origin) { error(response,403,"FORBIDDEN");return false }
                    if(request.contentLengthLong>128*1024 && !request.contentType.orEmpty().startsWith("multipart/form-data")) { error(response,400,"VALIDATION");return false }
                }
                return true
            }
        }).addPathPatterns("/api/**")
    }
    private fun error(response:HttpServletResponse,status:Int,code:String) { response.status=status;response.contentType="application/json;charset=UTF-8";response.writer.write("{\"code\":\"$code\",\"message\":\"${messageFor(code)}\"}") }
}
fun messageFor(code:String)=when(code) {
    "VALIDATION" -> "입력값을 확인하세요.";"FORBIDDEN" -> "이 작업을 수행할 권한이 없습니다.";"UNAUTHENTICATED" -> "다시 로그인하세요.";"NOT_FOUND" -> "대상을 찾을 수 없습니다.";"CONFLICT" -> "다른 변경이 저장됐습니다. 최신 내용을 다시 조회하세요.";"INVALID_STATE" -> "현재 상태에서는 저장할 수 없습니다.";"DUPLICATE_ACTION" -> "같은 제출 번호에 다른 내용이 있습니다.";"PROCESSING" -> "같은 제출을 처리 중입니다. 잠시 후 다시 확인하세요.";"AUTH_PROVIDER_UNAVAILABLE" -> "인증 제공자에 연결할 수 없습니다.";else -> "처리를 확인하지 못했습니다. 같은 제출 번호로 다시 확인하세요."
}
@RestControllerAdvice
class ApiErrors {
    @ExceptionHandler(BusinessFailure::class) fun business(error:BusinessFailure):ResponseEntity<Map<String,Any?>> {
        val status=when(error.code) { "VALIDATION"->400;"UNAUTHENTICATED"->401;"FORBIDDEN"->403;"NOT_FOUND"->404;"CONFLICT","INVALID_STATE","DUPLICATE_ACTION"->409;"PROCESSING"->202;"AUTH_PROVIDER_UNAVAILABLE"->503;else->500 }
        val response=ResponseEntity.status(status)
        if(error.code=="PROCESSING") response.header("Retry-After","2")
        return response.body(mapOf("code" to error.code,"message" to messageFor(error.code),"fieldErrors" to error.fields,"refreshRequired" to (error.code=="CONFLICT"),"retryAfter" to if(error.code=="PROCESSING") 2 else null))
    }
    @ExceptionHandler(Exception::class) fun internal(error:Exception):ResponseEntity<Map<String,Any?>> {
        val validation=error is MaxUploadSizeExceededException || error is HttpMessageNotReadableException || error is org.springframework.web.bind.MissingServletRequestParameterException || error is org.springframework.web.multipart.support.MissingServletRequestPartException
        val code=if(validation) "VALIDATION" else "SAVE_FAILED"
        return ResponseEntity.status(if(validation) 400 else 500).body(mapOf("code" to code,"message" to messageFor(code)))
    }
}

@org.springframework.stereotype.Component
class ApiBodyLimitFilter:org.springframework.web.filter.OncePerRequestFilter() {
    override fun doFilterInternal(request:HttpServletRequest,response:HttpServletResponse,chain:jakarta.servlet.FilterChain) {
        if(!request.requestURI.startsWith("/api/") || request.method in listOf("GET","HEAD","OPTIONS") || request.contentType.orEmpty().startsWith("multipart/form-data")) { chain.doFilter(request,response);return }
        val wrapper=object:jakarta.servlet.http.HttpServletRequestWrapper(request) {
            override fun getInputStream():jakarta.servlet.ServletInputStream {
                val stream=super.getInputStream()
                return object:jakarta.servlet.ServletInputStream() {
                    private var bytes=0L
                    private fun count(value:Int):Int { if(value>0) { bytes+=value;if(bytes>128*1024) throw java.io.IOException("BODY_LIMIT"); };return value }
                    override fun read():Int=stream.read().also { if(it!=-1) count(1) }
                    override fun read(buffer:ByteArray,offset:Int,length:Int):Int=count(stream.read(buffer,offset,length))
                    override fun isFinished():Boolean=stream.isFinished
                    override fun isReady():Boolean=stream.isReady
                    override fun setReadListener(listener:jakarta.servlet.ReadListener)=stream.setReadListener(listener)
                }
            }
        }
        chain.doFilter(wrapper,response)
    }
}
