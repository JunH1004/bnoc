package bnoc

import java.time.Instant
import java.time.LocalDate

/** External subject stays private; subjectRef is the service's opaque account reference. */
data class Actor(val id:String, val role:String, val displayName:String, val department:String, val teamId:String?=null, val active:Boolean=true,
    val subjectRef:String=id, val departmentManager:Boolean=false, val accessAdmin:Boolean=false, val revision:Long=1) {
    fun view():Map<String,Any?> = mapOf("id" to subjectRef,"role" to role,"displayName" to displayName,"department" to department,"teamId" to teamId,
        "rank" to "","contactId" to "","departmentManager" to departmentManager,"accessAdmin" to accessAdmin)
}
data class RequestRecord(
    val number:String, val requesterSubject:String?, val requesterDisplayText:String, val registeredBy:String,
    val category:String, val subcategories:Map<String,String>, var detail:String, var location:String, var contact:String,
    val equipmentId:String?=null, val maintenanceTarget:Map<String,String>?=null,
    var scheduledAt:String?=null, var documentRef:String?=null, var attachments:List<Map<String,Any?>> = emptyList(),
    var status:String="대기", val registeredAt:String, var updatedAt:String=registeredAt,
    var revision:Long=1, var priority:String?=null, var assignedAt:String?=null)
data class WorkRecord(
    val number:String, val requestNumber:String, val teamId:String, var status:String="배정",
    var schedule:String?=null, var memo:String?=null, var returnReason:String?=null,
    var completion:Map<String,String>?=null, var resolvedBy:List<String> = emptyList(),
    val replaces:String?=null, val origin:String="assigned", var revision:Long=1,
    var assignedPersonRefs:List<String> = emptyList(), val assignedAt:String?=null)
data class Command(val type:String, val operationId:String, val requestNumber:String?=null, val workNumber:String?=null, val expectedRevision:Long?=null, val payload:Map<String,Any?> = emptyMap())
data class CommandResult(val ok:Boolean=true,val requestNumber:String?=null,val workNumber:String?=null,val publicRef:String?=null,val revision:Long?=null,val state:String?=null,val priority:String?=null,val replayed:Boolean=false)
class BusinessFailure(val code:String,val fields:Map<String,String>?=null):RuntimeException(code)
fun reject(code:String,fields:Map<String,String>?=null):Nothing=throw BusinessFailure(code,fields)
fun text(payload:Map<String,Any?>,field:String,max:Int,required:Boolean=false):String {
    val value=payload[field]
    if(value!=null && value !is String) reject("VALIDATION",mapOf(field to "문자열을 입력하세요."))
    val result=(value as? String)?.trim().orEmpty()
    if(result.length>max || (required && result.isBlank())) reject("VALIDATION",mapOf(field to if(result.isBlank()) "필수 입력입니다." else "최대 ${max}자까지 입력하세요."))
    return result
}
fun dateValue(value:String):String {
    if(!value.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) || runCatching { LocalDate.parse(value) }.isFailure) reject("VALIDATION",mapOf("date" to "날짜를 확인하세요."))
    return value
}
fun instantValue(value:String?,field:String="date"):String? {
    if(value.isNullOrBlank()) return null
    return runCatching { Instant.parse(value).toString() }.getOrElse { reject("VALIDATION",mapOf(field to "UTC ISO 8601 시각을 입력하세요.")) }
}
fun stringRefs(value:Any?,field:String):List<String> {
    val values=value as? List<*> ?: reject("VALIDATION",mapOf(field to "목록을 확인하세요."))
    val refs=values.map { it as? String ?: reject("VALIDATION") }
    if(refs.distinct().size!=refs.size || refs.size>500) reject("VALIDATION",mapOf(field to "중복 또는 너무 많은 항목입니다."))
    return refs
}
