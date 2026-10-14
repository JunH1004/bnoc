package bnoc

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.servlet.FilterChain
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.filter.OncePerRequestFilter
import org.springframework.web.util.UrlPathHelper

@RestController
class PublicIdentityController(val api:ApiController) {
    @RequestMapping(value=["/identity","/identity/**","/control","/control/**","/feeds","/feeds/**"])
    fun proxyIdentity(request:HttpServletRequest)=api.proxyIdentity(request)
}

@Component
class PublicIdentityBoundaryFilter(val api:ApiController):OncePerRequestFilter() {
    override fun doFilterInternal(request:HttpServletRequest,response:HttpServletResponse,chain:FilterChain) {
        val helper=UrlPathHelper.defaultInstance
        val path=helper.removeSemicolonContent(helper.getPathWithinApplication(request))
        // Spring의 경로 해석 변형은 차단에만 사용한다. 허용은 원시 /identity 검사로 유지한다.
        val forbidden=(path=="/identity" && (request.requestURI!="/identity" || request.method !in listOf("GET","POST"))) || path.startsWith("/identity/") || path=="/control" || path.startsWith("/control/") || path=="/feeds" || path.startsWith("/feeds/")
        if(forbidden) {
            val error=api.proxyIdentity(request)
            response.status=error.statusCode.value()
            error.headers.forEach { name,values -> values.forEach { response.addHeader(name,it) } }
            error.body?.let { response.outputStream.write(it) }
            return
        }
        chain.doFilter(request,response)
    }
}
