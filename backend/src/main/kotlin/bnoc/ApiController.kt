package bnoc

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import org.springframework.http.ResponseEntity
import org.springframework.http.HttpHeaders
import org.springframework.http.ContentDisposition
import org.springframework.http.MediaType
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.annotation.Isolation
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

@RestController
@RequestMapping("/api")
class ApiController(val auth:AuthService,val db:Database,val workflow:WorkflowService,val query:QueryService,val files:AttachmentService,val situation:SituationService) {
    private fun actor(request:HttpServletRequest)=auth.actor(request) ?: reject("UNAUTHENTICATED")
    private fun envelope(data:Any?):Map<String,Any?> = mapOf("data" to data,"queriedAt" to Instant.now().toString())
    private fun page(params:Map<String,String>,items:List<Any?>):Map<String,Any?> {
        val page=params["page"]?.toIntOrNull() ?: if(params["page"]==null) 0 else reject("VALIDATION")
        val size=params["size"]?.toIntOrNull() ?: if(params["size"]==null) 20 else reject("VALIDATION")
        if(page<0 || size !in 1..100 || page>1000000) reject("VALIDATION",mapOf("page" to "페이지 조건을 확인하세요."))
        val start=(page.toLong()*size).coerceAtMost(items.size.toLong()).toInt()
        return mapOf("items" to items.drop(start).take(size),"total" to items.size,"page" to page,"size" to size)
    }
    private fun pageEnvelope(data:Map<String,Any?>):Map<String,Any?> = envelope(data)+data.filterKeys { it in setOf("total","page","size") }
    @GetMapping("/auth/start") fun start(request:HttpServletRequest)=envelope(auth.start(request))
    fun proxyIdentity(request:HttpServletRequest)=auth.proxyIdentity(request)
    @PostMapping("/auth/complete") fun complete(request:HttpServletRequest,@RequestBody payload:Map<String,Any?>)=auth.complete(request,payload)
    @PostMapping("/auth/logout") fun logout(request:HttpServletRequest):Map<String,Boolean> { request.getSession(false)?.invalidate();return mapOf("ok" to true) }
    @GetMapping("/session") fun session(request:HttpServletRequest)=envelope(mapOf("actor" to actor(request).view(),"teams" to db.teams,"departments" to db.departments,"csrfToken" to auth.csrf(request),"sourceMode" to "simulation"))
    @GetMapping("/requests") fun requests(request:HttpServletRequest,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,query.list(actor(request),filters(request,params))))
    @GetMapping("/requests/{number}") fun detail(request:HttpServletRequest,@PathVariable number:String)=envelope(query.detail(actor(request),number))
    @GetMapping("/requests/{number}/history") fun history(request:HttpServletRequest,@PathVariable number:String,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,query.history(actor(request),number)))
    @GetMapping("/notifications") fun notifications(request:HttpServletRequest,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,query.notifications(actor(request))))
    @GetMapping("/schedule") fun schedule(request:HttpServletRequest,@RequestParam params:Map<String,String>)=envelope(query.schedule(actor(request),params))
    @GetMapping("/overview") fun overview(request:HttpServletRequest,@RequestParam params:Map<String,String>):Map<String,Any?> {
        val data=query.overview(actor(request),filters(request,params))
        @Suppress("UNCHECKED_CAST") val pagination=page(params,data["list"] as List<Any?>)
        return pageEnvelope(data+mapOf("list" to pagination["items"])+pagination.filterKeys { it!="items" })
    }
    @GetMapping("/work-overview") fun shared(request:HttpServletRequest,@RequestParam params:Map<String,String>):Map<String,Any?> {
        val data=query.shared(actor(request),filters(request,params))
        @Suppress("UNCHECKED_CAST") val pagination=page(params,data["items"] as List<Any?>)
        return pageEnvelope(data+pagination)
    }
    @GetMapping("/personnel-roster","/roster") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun roster(request:HttpServletRequest,@RequestParam(required=false) department:String?)=envelope(workflow.operations.listRoster(actor(request),department ?: actor(request).department))
    @GetMapping("/personnel") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun personnel(request:HttpServletRequest,@RequestParam(required=false) date:String?,@RequestParam(required=false) department:String?)=envelope(workflow.operations.personnel(actor(request),date ?: LocalDate.now(ZoneId.of("Asia/Seoul")).toString(),department))
    @GetMapping("/night-duty") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun night(request:HttpServletRequest,@RequestParam(required=false) date:String?,@RequestParam(required=false) department:String?)=envelope(workflow.operations.night(actor(request),date ?: LocalDate.now(ZoneId.of("Asia/Seoul")).toString(),department))
    @GetMapping("/situation") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun situations(request:HttpServletRequest):Map<String,Any?> { actor(request);return envelope(mapOf("gps" to situation.snapshot("gps"),"cpcon" to situation.snapshot("cpcon"))) }
    @GetMapping("/situation/{kind}") fun situation(request:HttpServletRequest,@PathVariable kind:String):Map<String,Any?> { actor(request);return envelope(situation.snapshot(kind)) }
    @GetMapping("/notices") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun notices(request:HttpServletRequest,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,workflow.operations.notices(actor(request))))
    @GetMapping("/notices/{ref}") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun notice(request:HttpServletRequest,@PathVariable ref:String)=envelope(workflow.operations.notice(actor(request),ref))
    @GetMapping("/access-assignments","/access") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun access(request:HttpServletRequest,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,workflow.operations.access(actor(request))))
    @GetMapping("/operations/{id}") fun receipt(request:HttpServletRequest,@PathVariable id:String)=workflow.receipt(actor(request),id)
    private fun filters(request:HttpServletRequest,params:Map<String,String>)=params+(request.getParameterValues("status")?.let { mapOf("status" to it.joinToString(",")) } ?: emptyMap())
    @PostMapping("/commands") fun command(request:HttpServletRequest,@RequestBody input:Map<String,Any?>):CommandResult {
        if(input.keys.any { it !in setOf("type","operationId","requestNumber","workNumber","expectedRevision","payload") }) reject("VALIDATION")
        val payload=input["payload"] as? Map<*,*> ?: reject("VALIDATION")
        if(payload.keys.any { it !is String }) reject("VALIDATION")
        @Suppress("UNCHECKED_CAST") val typed=payload as Map<String,Any?>
        val revision=input["expectedRevision"]?.let { val n=it as? Number ?: reject("VALIDATION");if(n.toDouble()!=n.toLong().toDouble() || n.toLong()<0) reject("VALIDATION");n.toLong() }
        for(key in listOf("requestNumber","workNumber")) if(input[key]!=null && input[key] !is String) reject("VALIDATION")
        return workflow.execute(actor(request),Command(input["type"] as? String ?: reject("VALIDATION"),input["operationId"] as? String ?: reject("VALIDATION"),input["requestNumber"] as? String,input["workNumber"] as? String,revision,typed))
    }
    @PostMapping("/attachments") fun upload(request:HttpServletRequest,@RequestParam resourceKind:String,@RequestPart file:MultipartFile)=envelope(files.upload(actor(request),resourceKind,file))
    @GetMapping("/attachments/{id}","/attachments/{id}/download") fun download(request:HttpServletRequest,@PathVariable id:String):ResponseEntity<ByteArray> {
        val data=files.download(actor(request),id)
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(data.first["file_name"] as String,Charsets.UTF_8).build().toString()).header("X-Content-Type-Options","nosniff").header("Cache-Control","no-store").contentType(MediaType.parseMediaType(data.first["content_type"] as String)).body(data.second)
    }
}
