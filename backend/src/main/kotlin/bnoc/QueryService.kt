package bnoc

import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.annotation.Isolation
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Service
@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
class QueryService(val db:Database,val workflow:WorkflowService) {
    private val seoul=ZoneId.of("Asia/Seoul")
    private val historyTime=DateTimeFormatter.ofPattern("uuuu. M. d. HH:mm").withZone(seoul)
    private val timeFields=setOf("scheduledAt","schedule","배정 시각(접수 시간)","실제 시작 시각","실제 완료 시각")
    private fun displayHistoryTime(value:Any?):String=if(value==null) "미정" else runCatching { historyTime.format(Instant.parse(value as String)) }.getOrDefault("시각 확인 불가")
    fun summary(r:RequestRecord):Map<String,Any?> = mapOf("requestNumber" to r.number,"requesterDisplayText" to r.requesterDisplayText,"category" to r.category,"status" to r.status,"teamIds" to db.works(r.number).map { it.teamId }.distinct(),"updatedAt" to r.updatedAt,"priority" to r.priority,"assignedAt" to r.assignedAt)
    fun list(actor:Actor,filter:Map<String,String>):List<Map<String,Any?>> {
        validateFilter(filter)
        return db.requests().filter { workflow.visible(actor,it) && matches(it,filter,actor) }.sortedWith(compareByDescending<RequestRecord> { Instant.parse(it.updatedAt) }.thenByDescending { it.number.toLong() }).map { summary(it) }
    }
    private fun validateFilter(filter:Map<String,String>) {
        listOf("from","to").forEach { filter[it]?.takeIf { value -> value.isNotBlank() }?.let { dateValue(it) } }
        if(filter.values.any { it.length>500 }) reject("VALIDATION")
        filter["teamId"]?.takeIf { it.isNotBlank() }?.let { if(it !in db.teams) reject("VALIDATION") }
        filter["priority"]?.takeIf { it.isNotBlank() }?.let { if(it !in listOf("general","urgent","unclassified")) reject("VALIDATION") }
    }
    private fun matches(r:RequestRecord,f:Map<String,String>,actor:Actor):Boolean {
        fun value(key:String)=f[key].orEmpty()
        val registered=Instant.parse(r.registeredAt).atZone(seoul).toLocalDate().toString()
        return (value("from").isBlank() || registered>=value("from")) && (value("to").isBlank() || registered<=value("to")) &&
            (value("status").isBlank() || r.status in value("status").split(',')) && (value("category").isBlank() || r.category==value("category")) &&
            (value("teamId").isBlank() || db.works(r.number).any { it.teamId==value("teamId") }) && (value("location").isBlank() || r.location.contains(value("location"))) &&
            (value("requestNumber").isBlank() || r.number.contains(value("requestNumber"))) && (value("requesterDeptOrName").isBlank() || actor.role!="bnoc" || r.requesterDisplayText.contains(value("requesterDeptOrName"))) &&
            (value("priority").isBlank() || if(value("priority")=="unclassified") r.priority==null else r.priority==value("priority"))
    }
    fun requireRequest(actor:Actor,number:String):RequestRecord {
        val request=db.request(number) ?: reject("NOT_FOUND")
        if(!workflow.visible(actor,request)) reject("NOT_FOUND")
        return request
    }
    fun detail(actor:Actor,number:String):Map<String,Any?> {
        val request=requireRequest(actor,number)
        val works=db.works(number).map { w ->
            val common=mutableMapOf<String,Any?>("workNumber" to w.number,"teamId" to w.teamId,"status" to w.status,"schedule" to w.schedule,"revision" to w.revision,"resolved" to w.resolvedBy.isNotEmpty(),"editable" to (request.status!="취소" && actor.role=="team" && actor.teamId==w.teamId && w.origin!="after-action" && w.resolvedBy.isEmpty()),"assignedAt" to w.assignedAt,"origin" to w.origin)
            if(actor.role=="bnoc" || (actor.role=="team" && actor.teamId==w.teamId)) {
                common["memo"]=w.memo;common["returnReason"]=w.returnReason
                common["assignedPersonRefs"]=w.assignedPersonRefs
                common["assignedPersons"]=w.assignedPersonRefs.mapNotNull { ref -> db.rows("SELECT display_name FROM bnoc_roster WHERE person_ref=?",ref).firstOrNull()?.let { mapOf("personRef" to ref,"displayName" to it["display_name"]) } }
                common["completion"]=w.completion?.let { c -> c.filterKeys { it!="completedBy" }+mapOf("completedBy" to (db.actor(c["completedBy"].orEmpty())?.displayName ?: "담당자")) }
                common["completionActor"]=w.completion?.get("completedBy")?.let { db.actor(it)?.displayName ?: "담당자" }
            }
            common
        }
        return summary(request)+mapOf("detail" to request.detail,"location" to request.location,"contact" to if(actor.role in listOf("requester","bnoc")) request.contact else null,"subcategories" to request.subcategories,"equipmentId" to request.equipmentId,"maintenanceTarget" to if(actor.role=="bnoc") request.maintenanceTarget else null,"scheduledAt" to request.scheduledAt,"documentRef" to request.documentRef,"registeredBy" to (db.actor(request.registeredBy)?.displayName ?: "담당자"),"registeredAt" to request.registeredAt,"revision" to request.revision,"workItems" to works,"attachments" to request.attachments,"history" to emptyList<Any>(),"canEdit" to workflow.canEdit(actor,request),"canCancel" to (actor.role=="requester" && request.requesterSubject==actor.id && request.status!="취소"),"canAssign" to (actor.role=="bnoc" && request.status in listOf("대기","문서 대기") && works.isEmpty()),"canChangePriority" to (actor.role=="bnoc" && request.status!="취소"))
    }
    fun history(actor:Actor,number:String):List<Map<String,Any?>> {
        requireRequest(actor,number)
        val works=db.works(number).filter { actor.role!="team" || it.teamId==actor.teamId }.map { it.number }
        return db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY recorded_at DESC,history_id DESC",number).filter { row ->
            val field=row["field_name"] as String;val work=row["work_number"] as? String
            (work==null || work in works) && (actor.role!="requester" || (work==null && field in listOf("등록","상태","detail","location","contact","scheduledAt","documentRef","attachments","일반·긴급"))) && (actor.role!="team" || field!="contact")
        }.map { row ->
            val subject=row["actor_subject"] as String;val field=row["field_name"] as String
            val label=when(field) {
                "scheduledAt" -> "희망 일정";"schedule" -> "작업 일정"
                "detail" -> "내용";"location" -> "위치";"contact" -> "연락처"
                "documentRef" -> "문서 참조정보";"attachments" -> "첨부파일";"memo" -> "작업 메모"
                else -> field
            }
            fun render(value:Any?):String {
                if(value==null) return if(field in timeFields) "미정" else if(field=="일반·긴급") "미분류" else "없음"
                val objectValue=runCatching { db.json.readValue(value as String,Any::class.java) }.getOrNull()
                if(field=="일반·긴급") return when(objectValue) { "general" -> "일반";"urgent" -> "긴급";null -> "미분류";else -> "분류 확인 불가" }
                if(field in timeFields) return displayHistoryTime(objectValue)
                if(field=="완료정보") { val c=objectValue as? Map<*,*> ?: return "없음";return "${db.actor(c["completedBy"].toString())?.displayName ?: "담당자"} · ${displayHistoryTime(c["completedAt"])}" }
                if(field=="담당 인원") return (objectValue as? List<*>)?.mapNotNull { ref -> db.rows("SELECT display_name FROM bnoc_roster WHERE person_ref=?",ref).firstOrNull()?.get("display_name") }?.joinToString(", ").orEmpty().ifBlank { "미선택" }
                if(field=="attachments") return (objectValue as? List<*>)?.mapNotNull { item -> (item as? Map<*,*>)?.get("fileName") }?.joinToString(", ").orEmpty().ifBlank { "없음" }
                return objectValue?.toString() ?: "없음"
            }
            val historicalFiles=if(field=="attachments") listOf("before_value","after_value").flatMap { key -> (row[key] as? String)?.let { runCatching { db.json.readValue(it,List::class.java) }.getOrNull()?.mapNotNull { item -> (item as? Map<*,*>)?.get("id") as? String } } ?: emptyList() }.distinct() else emptyList()
            mapOf("at" to row["recorded_at"],"actorLabel" to if(actor.role=="requester" && subject!=actor.id) "담당자" else db.actor(subject)?.displayName ?: "담당자","field" to field,"summary" to if(row["before_value"]==null) "$label: ${render(row["after_value"])}" else "$label: ${render(row["before_value"])} → ${render(row["after_value"])}","attachments" to historicalFiles.mapNotNull { id -> db.rows("SELECT attachment_ref,file_name,byte_size,content_type FROM bnoc_attachments WHERE attachment_ref=?",id).firstOrNull()?.let { mapOf("id" to it["attachment_ref"],"fileName" to it["file_name"],"size" to it["byte_size"],"type" to it["content_type"]) } })
        }
    }
    fun notifications(actor:Actor):List<Map<String,Any?>> = db.rows("SELECT event_name,request_number,work_number,recorded_at,is_read FROM bnoc_notifications WHERE recipient_subject=? ORDER BY recorded_at DESC,notification_id DESC",actor.id).filter { row -> db.request(row["request_number"] as String)?.let { workflow.visible(actor,it) } ?: false }.map { mapOf("event" to it["event_name"],"relatedRequestId" to it["request_number"],"relatedWorkItemId" to it["work_number"],"at" to it["recorded_at"],"read" to it["is_read"]) }
    fun schedule(actor:Actor,filter:Map<String,String>):Map<String,Any> {
        if(actor.role !in listOf("team","bnoc")) reject("FORBIDDEN")
        fun boundary(value:String)=if(value.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) LocalDate.parse(dateValue(value)).atStartOfDay(seoul).toInstant() else Instant.parse(instantValue(value)!!)
        val from=filter["from"]?.takeIf { it.isNotBlank() }?.let { boundary(it) } ?: LocalDate.now(seoul).atStartOfDay(seoul).toInstant()
        val to=filter["to"]?.takeIf { it.isNotBlank() }?.let { boundary(it) } ?: from.plusSeconds(86400)
        if(!to.isAfter(from) || to.isAfter(from.plusSeconds(730L*86400))) reject("VALIDATION",mapOf("to" to "조회 기간을 확인하세요."))
        val valid=db.allWorks().filter { (actor.role=="bnoc" || it.teamId==actor.teamId) && it.resolvedBy.isEmpty() && db.request(it.requestNumber)?.status!="취소" }
        fun entry(w:WorkRecord)=mapOf("workNumber" to w.number,"teamId" to w.teamId,"request" to summary(db.request(w.requestNumber)!!),"scheduledAt" to w.schedule,"status" to w.status)
        val scheduled=valid.filter { work -> work.schedule?.let { Instant.parse(it).let { instant -> !instant.isBefore(from) && instant.isBefore(to) } } ?: false }.sortedWith(compareBy<WorkRecord> { it.schedule }.thenBy { it.number }).map { entry(it) }
        return mapOf("entries" to scheduled,"unscheduled" to valid.filter { it.schedule==null && it.status!="완료" }.map { entry(it) },"from" to from.toString(),"to" to to.toString())
    }
    fun overview(actor:Actor,filter:Map<String,String>):Map<String,Any> {
        if(actor.role!="bnoc") reject("FORBIDDEN")
        val list=list(actor,filter)
        return mapOf("total" to list.size,"byStatus" to listOf("대기","문서 대기","배정","작업 중","완료","취소").associateWith { state -> list.count { it["status"]==state } },"list" to list,"teams" to db.teams)
    }
    fun shared(actor:Actor,filter:Map<String,String>):Map<String,Any> {
        validateFilter(filter)
        val requests=db.requests().associateBy { it.number }
        fun match(work:WorkRecord,r:RequestRecord):Boolean=(filter["teamId"].isNullOrBlank() || work.teamId==filter["teamId"]) && (filter["status"].isNullOrBlank() || work.status in filter["status"]!!.split(',')) && (filter["category"].isNullOrBlank() || r.category==filter["category"]) && (filter["systemType"].isNullOrBlank() || r.subcategories["systemType"]==filter["systemType"]) && (filter["workType"].isNullOrBlank() || (r.subcategories["workType"] ?: r.subcategories["meetingType"])==filter["workType"]) && (filter["priority"].isNullOrBlank() || if(filter["priority"]=="unclassified") r.priority==null else r.priority==filter["priority"]) && (filter["requestNumber"].isNullOrBlank() || r.number==filter["requestNumber"])
        val all=db.allWorks()
        val valid=all.filter { work -> val r=requests[work.requestNumber]!!;r.status!="취소" && work.resolvedBy.isEmpty() && work.origin=="assigned" && match(work,r) }
        fun counts(works:List<WorkRecord>)=mapOf("total" to works.size,"assigned" to works.size,"completed" to works.count { it.status=="완료" },"remaining" to works.count { it.status!="완료" },"returned" to works.count { it.status=="반환" },"inProgress" to works.count { it.status=="작업 중" })
        val bucket=filter["bucket"].orEmpty()
        if(bucket !in listOf("","assigned","completed","remaining","returned","after-action","unassigned")) reject("VALIDATION")
        val selected=when(bucket) { "completed" -> valid.filter { it.status=="완료" };"remaining" -> valid.filter { it.status!="완료" };"returned" -> valid.filter { it.status=="반환" };"after-action" -> all.filter { work -> val r=requests[work.requestNumber]!!;r.status!="취소" && work.origin=="after-action" && match(work,r) };else -> valid }
        val workItems=selected.sortedWith(compareByDescending<WorkRecord> { it.assignedAt?.let { at -> Instant.parse(at) } ?: Instant.EPOCH }.thenByDescending { it.requestNumber.toLong() }.thenByDescending { it.number.substringAfterLast('-').toInt() }).map { work ->
            val r=requests[work.requestNumber]!!
            mapOf("workNumber" to work.number,"requestNumber" to r.number,"department" to work.teamId,"teamId" to work.teamId,"category" to r.category,"workType" to (r.subcategories["workType"] ?: r.subcategories["meetingType"]),"status" to work.status,"priority" to r.priority,"schedule" to work.schedule,"canOpenDetail" to workflow.visible(actor,r))
        }
        val unassignedRows=requests.values.filter { r -> r.status in listOf("대기","문서 대기") && all.none { it.requestNumber==r.number } && (filter["category"].isNullOrBlank() || filter["category"]==r.category) && (filter["systemType"].isNullOrBlank() || r.subcategories["systemType"]==filter["systemType"]) && (filter["workType"].isNullOrBlank() || filter["workType"]==(r.subcategories["workType"] ?: r.subcategories["meetingType"])) && (filter["priority"].isNullOrBlank() || if(filter["priority"]=="unclassified") r.priority==null else filter["priority"]==r.priority) && filter["teamId"].isNullOrBlank() && filter["status"].isNullOrBlank() && (filter["requestNumber"].isNullOrBlank() || r.number==filter["requestNumber"]) }
        val afterAction=all.count { work -> val r=requests[work.requestNumber]!!;r.status!="취소" && work.origin=="after-action" && match(work,r) }
        val items=if(bucket=="unassigned") unassignedRows.sortedWith(compareByDescending<RequestRecord> { Instant.parse(it.registeredAt) }.thenByDescending { it.number.toLong() }).map { r -> mapOf("requestNumber" to r.number,"category" to r.category,"status" to r.status,"priority" to r.priority,"canOpenDetail" to workflow.visible(actor,r)) } else workItems
        return mapOf("items" to items,"total" to items.size,"counts" to counts(valid),"byDepartment" to db.teams.map { team -> mapOf("department" to team)+counts(valid.filter { it.teamId==team }) },"unassignedRequests" to unassignedRows.size,"afterActionCompleted" to afterAction,"basis" to "현재 상태 기준")
    }
}
