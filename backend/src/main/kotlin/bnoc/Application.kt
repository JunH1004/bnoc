package bnoc

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

@SpringBootApplication
@EnableScheduling
class Application

fun main(args: Array<String>) {
    if(System.getenv("BNOC_PUBLIC_URL")?.startsWith("https://")==true) System.setProperty("server.servlet.session.cookie.secure","true")
    runApplication<Application>(*args)
}
