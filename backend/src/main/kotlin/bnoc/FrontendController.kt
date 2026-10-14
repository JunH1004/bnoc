package bnoc

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry
import org.springframework.stereotype.Controller
import org.springframework.web.bind.annotation.GetMapping

@Configuration
class FrontendResources(@Value("\${bnoc.frontend-root}") val root:String):WebMvcConfigurer {
    override fun addResourceHandlers(registry:ResourceHandlerRegistry) {
        val location=java.nio.file.Path.of(root).toAbsolutePath().toUri().toString().let { if(it.endsWith('/')) it else "$it/" }
        registry.addResourceHandler("/assets/**").addResourceLocations("${location}assets/","classpath:/static/assets/")
        registry.addResourceHandler("/favicon.ico","/robots.txt","/index.html").addResourceLocations(location,"classpath:/static/")
    }
}
@Controller
class FrontendController {
    @GetMapping("/","/login","/auth/callback","/requests","/requests/**","/new","/notifications","/overview","/schedule","/operations/**","/work-overview","/personnel","/night-duty","/situation","/notices","/notices/**","/access","/after-action","/roster","/personnel-roster")
    fun app():String="forward:/index.html"
}
