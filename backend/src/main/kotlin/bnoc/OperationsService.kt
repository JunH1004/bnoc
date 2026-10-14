package bnoc

import com.fasterxml.jackson.module.kotlin.readValue
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

class OperationsService(val db:Database) {
    companion object {
        val fields=mapOf("savePersonnelRoster" to setOf("department","entries"),"saveDailyPersonnel" to setOf("department","date","entries"),
            "saveNightDuty" to setOf("department","date","personRefs"),"createDirective" to setOf("title","body","attachmentRefs"),
            "updateDirective" to setOf("noticeRef","title","body","attachmentRefs"),"changeAccess" to setOf("subjectRef","role","department","teamId","departmentManager","active"))
    }
    private fun now()=Instant.now().toString()
    private fun requireDepartmentReader(actor:Actor) { if(actor.role !in listOf("bnoc","team") && !actor.departmentManager) reject("FORBIDDEN") }
    fun authorize(actor:Actor,command:Command) {
        when(command.type) {
            "savePersonnelRoster","saveDailyPersonnel","saveNightDuty" -> {
                if(actor.role=="admin" || !actor.departmentManager) reject("FORBIDDEN")
                val department=text(command.payload,"department",100,true)
                if(department!=actor.department || department !in db.departments) reject("FORBIDDEN")
            }
            "createDirective","updateDirective" -> if(actor.role!="bnoc") reject("FORBIDDEN")
            "changeAccess" -> if(!actor.accessAdmin || actor.role!="admin") reject("FORBIDDEN")
            else -> reject("VALIDATION")
        }
    }
    fun authorizeReceipt(actor:Actor,type:String,result:CommandResult) {
        when(type) {
            "savePersonnelRoster","saveDailyPersonnel","saveNightDuty" -> if(actor.role=="admin" || !actor.departmentManager || result.publicRef?.substringBefore('|')!=actor.department) reject("FORBIDDEN")
            "createDirective","updateDirective" -> if(actor.role!="bnoc") reject("FORBIDDEN")
            "changeAccess" -> if(!actor.accessAdmin || actor.role!="admin") reject("FORBIDDEN")
        }
    }
    fun execute(actor:Actor,command:Command,workflow:WorkflowService):CommandResult=when(command.type) {
        "savePersonnelRoster" -> saveRoster(actor,command)
        "saveDailyPersonnel" -> saveDaily(actor,command)
        "saveNightDuty" -> saveNight(actor,command)
        "createDirective","updateDirective" -> saveDirective(actor,command,workflow)
        "changeAccess" -> changeAccess(actor,command)
        else -> reject("VALIDATION")
    }
    private fun revision(command:Command,actual:Long) { if(command.expectedRevision==null) reject("VALIDATION",mapOf("expectedRevision" to "버전이 필요합니다."));if(command.expectedRevision!=actual) reject("CONFLICT") }
    fun listRoster(actor:Actor,department:String):Map<String,Any?> {
        requireDepartmentReader(actor)
        if(department !in db.departments) reject("VALIDATION",mapOf("department" to "부서를 선택하세요."))
        val version=db.rows("SELECT revision FROM bnoc_roster_versions WHERE department=?",department).firstOrNull()?.get("revision") as? Number
        return mapOf("department" to department,"revision" to (version?.toLong() ?: 0),"entries" to roster(department))
    }
    fun roster(department:String):List<Map<String,Any?>> = db.rows("SELECT person_ref,display_name,active FROM bnoc_roster WHERE department=? ORDER BY display_name,person_ref",department).map { mapOf("personRef" to it["person_ref"],"displayName" to it["display_name"],"active" to it["active"]) }
    fun validateMembers(department:String,refs:List<String>,existing:List<String> = emptyList()):List<Map<String,Any?>> {
        if(refs.distinct().size!=refs.size) reject("VALIDATION",mapOf("personRefs" to "중복 인원을 제거하세요."))
        return refs.map { ref ->
            val row=db.rows("SELECT * FROM bnoc_roster WHERE person_ref=?",ref).firstOrNull() ?: reject("VALIDATION",mapOf("personRefs" to "부서 명부의 인원을 선택하세요."))
            if(row["department"]!=department || (row["active"]!=true && ref !in existing)) reject("VALIDATION",mapOf("personRefs" to "자기 부서의 활성 명부에서 선택하세요."))
            mapOf("personRef" to ref,"displayName" to row["display_name"])
        }
    }
    private fun saveRoster(actor:Actor,command:Command):CommandResult {
        val department=actor.department;db.lockResource("roster:$department")
        val before=roster(department);val actual=(db.rows("SELECT revision FROM bnoc_roster_versions WHERE department=?",department).firstOrNull()?.get("revision") as? Number)?.toLong() ?: 0
        revision(command,actual)
        val entries=command.payload["entries"] as? List<*> ?: reject("VALIDATION",mapOf("entries" to "명부를 확인하세요."))
        if(entries.size>500) reject("VALIDATION")
        val seen=mutableSetOf<String>()
        val updated=entries.map { item ->
            val row=item as? Map<*,*> ?: reject("VALIDATION")
            if(row.keys.any { it !in setOf("personRef","displayName","active") }) reject("VALIDATION")
            @Suppress("UNCHECKED_CAST") val p=row as Map<String,Any?>
            val ref=when(val input=p["personRef"]) { null -> UUID.randomUUID().toString();is String -> input;else -> reject("VALIDATION") }
            if(!seen.add(ref)) reject("VALIDATION",mapOf("entries" to "중복 인원을 제거하세요."))
            if(p["personRef"]!=null && before.none { it["personRef"]==ref }) reject("VALIDATION",mapOf("entries" to "자기 부서의 명부 참조를 확인하세요."))
            val active=p["active"] as? Boolean ?: reject("VALIDATION",mapOf("active" to "활성 여부를 확인하세요."))
            mapOf("personRef" to ref,"displayName" to text(p,"displayName",100,true),"active" to active)
        }
        val after=(updated+before.filter { it["personRef"] !in seen }.map { it+mapOf("active" to false) }).sortedBy { it["personRef"].toString() }
        val changed=before.sortedBy { it["personRef"].toString() }!=after
        if(changed) {
            after.forEach { entry -> db.jdbc.update("INSERT INTO bnoc_roster(person_ref,department,display_name,active) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),active=VALUES(active)",entry["personRef"],department,entry["displayName"],entry["active"]) }
            db.jdbc.update("INSERT INTO bnoc_roster_versions(department,revision) VALUES (?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision)",department,actual+1)
            db.operationsHistory(actor,"roster",department,before,after)
        }
        return CommandResult(publicRef=department,revision=if(changed) actual+1 else actual)
    }
    private fun savedRecords(table:String,department:String,date:String):Map<String,Any?>?=db.rows("SELECT * FROM $table WHERE department=? AND record_date=?",department,date).firstOrNull()
    private fun past(date:String)=LocalDate.parse(date).isBefore(LocalDate.now(ZoneId.of("Asia/Seoul")))
    private fun saveDaily(actor:Actor,command:Command):CommandResult {
        val date=dateValue(text(command.payload,"date",10,true));val department=actor.department;db.lockResource("personnel:$department:$date")
        val saved=savedRecords("bnoc_personnel",department,date);val actual=(saved?.get("revision") as? Number)?.toLong() ?: 0;revision(command,actual)
        val before=saved?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
        val entries=command.payload["entries"] as? List<*> ?: reject("VALIDATION")
        val refs=entries.map { (it as? Map<*,*>)?.get("personRef") as? String ?: reject("VALIDATION") }
        val members=validateMembers(department,refs,before.map { it["personRef"] as String }).associateBy { it["personRef"] }
        val after=entries.map { item ->
            val entry=item as Map<*,*>
            if(entry.keys.any { it !in setOf("personRef","status") } || entry["status"] !in listOf("leave","trip","available")) reject("VALIDATION",mapOf("status" to "휴가·출장·가용 중 선택하세요."))
            val ref=entry["personRef"] as String
            val display=if(past(date)) before.firstOrNull { it["personRef"]==ref }?.get("displayName") ?: members[ref]!!["displayName"] else members[ref]!!["displayName"]
            mapOf("personRef" to ref,"displayName" to display,"status" to entry["status"])
        }.sortedBy { it["personRef"].toString() }
        val changed=saved==null || before.sortedBy { it["personRef"].toString() }!=after
        if(changed) { persistRecords("bnoc_personnel",actor,date,actual+1,after);db.operationsHistory(actor,"personnel","$department|$date",before,after) }
        return CommandResult(publicRef="$department|$date",revision=if(changed) actual+1 else actual)
    }
    private fun saveNight(actor:Actor,command:Command):CommandResult {
        val date=dateValue(text(command.payload,"date",10,true));val department=actor.department;db.lockResource("night:$department:$date")
        val saved=savedRecords("bnoc_night_duty",department,date);val actual=(saved?.get("revision") as? Number)?.toLong() ?: 0;revision(command,actual)
        val before=saved?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
        val refs=stringRefs(command.payload["personRefs"],"personRefs")
        val members=validateMembers(department,refs,before.map { it["personRef"] as String })
        val after=members.map { entry -> if(past(date)) entry+mapOf("displayName" to (before.firstOrNull { it["personRef"]==entry["personRef"] }?.get("displayName") ?: entry["displayName"])) else entry }.sortedBy { it["personRef"].toString() }
        val changed=saved==null || before.sortedBy { it["personRef"].toString() }!=after
        if(changed) { persistRecords("bnoc_night_duty",actor,date,actual+1,after);db.operationsHistory(actor,"night-duty","$department|$date",before,after) }
        return CommandResult(publicRef="$department|$date",revision=if(changed) actual+1 else actual)
    }
    private fun persistRecords(table:String,actor:Actor,date:String,revision:Long,entries:List<Map<String,Any?>>)=db.jdbc.update("INSERT INTO $table(department,record_date,revision,records_json,saved_by,saved_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),records_json=VALUES(records_json),saved_by=VALUES(saved_by),saved_at=VALUES(saved_at)",actor.department,date,revision,db.json.writeValueAsString(entries),actor.id,now())
    fun personnel(actor:Actor,date:String,department:String?):Map<String,Any?> {
        requireDepartmentReader(actor);dateValue(date)
        val departments=selectedDepartments(department).map { d ->
            val row=savedRecords("bnoc_personnel",d,date)
            val saved=row?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
            val recorded=saved.map { it["personRef"] as String }.toSet()
            val entries=saved+roster(d).filter { it["active"]==true && it["personRef"] !in recorded }.map { mapOf("personRef" to it["personRef"],"displayName" to it["displayName"],"status" to null) }
            mapOf("department" to d,"revision" to ((row?.get("revision") as? Number)?.toLong() ?: 0),"submitted" to (row!=null),"entries" to entries,"counts" to mapOf("leave" to saved.count { it["status"]=="leave" },"trip" to saved.count { it["status"]=="trip" },"available" to saved.count { it["status"]=="available" },"unrecorded" to entries.count { it["status"]==null }))
        }
        return mapOf("date" to date,"departments" to departments)
    }
    fun night(actor:Actor,date:String,department:String?):Map<String,Any?> {
        requireDepartmentReader(actor);dateValue(date)
        return mapOf("date" to date,"departments" to selectedDepartments(department).map { d ->
            val row=savedRecords("bnoc_night_duty",d,date)
            val entries=row?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
            mapOf("department" to d,"revision" to ((row?.get("revision") as? Number)?.toLong() ?: 0),"submitted" to (row!=null),"entries" to entries)
        })
    }
    private fun selectedDepartments(department:String?):List<String> {
        if(department.isNullOrBlank()) return db.departments
        if(department !in db.departments) reject("VALIDATION")
        return listOf(department)
    }
    private fun saveDirective(actor:Actor,command:Command,workflow:WorkflowService):CommandResult {
        val payload=command.payload;val creating=command.type=="createDirective"
        val ref=if(creating) UUID.randomUUID().toString() else text(payload,"noticeRef",36,true)
        db.lockResource("notice:$ref")
        val before=if(creating) null else notice(actor,ref)
        val actual=(before?.get("revision") as? Number)?.toLong() ?: 0
        if(!creating) revision(command,actual)
        val title=text(payload,"title",200,true);val body=text(payload,"body",10000,true)
        val beforeAttachments=if(creating) emptyList() else db.attachmentMetadata("notice",ref)
        val afterAttachments=workflow.linkAttachments(actor,"notice",ref,payload["attachmentRefs"])
        val changed=creating || before!!["title"]!=title || before["body"]!=body || beforeAttachments.map { it["id"] }!=afterAttachments.map { it["id"] }
        if(changed) {
            if(creating) db.jdbc.update("INSERT INTO bnoc_notices VALUES (?,?,?,?,?,?,?)",ref,title,body,actor.id,now(),1,now())
            else db.jdbc.update("UPDATE bnoc_notices SET title=?,body=?,revision=?,updated_at=? WHERE notice_ref=?",title,body,actual+1,now(),ref)
            db.operationsHistory(actor,"notice",ref,before?.let { mapOf("title" to it["title"],"body" to it["body"],"attachments" to beforeAttachments) },mapOf("title" to title,"body" to body,"attachments" to afterAttachments))
        }
        return CommandResult(publicRef=ref,revision=if(changed) actual+1 else actual)
    }
    fun notices(actor:Actor):List<Map<String,Any?>> = db.rows("SELECT * FROM bnoc_notices ORDER BY updated_at DESC,notice_ref DESC").map { noticeDto(it) }
    fun notice(actor:Actor,ref:String):Map<String,Any?> = noticeDto(db.rows("SELECT * FROM bnoc_notices WHERE notice_ref=?",ref).firstOrNull() ?: reject("NOT_FOUND"))
    private fun noticeDto(row:Map<String,Any?>):Map<String,Any?> = mapOf("noticeRef" to row["notice_ref"],"title" to row["title"],"body" to row["body"],"createdAt" to row["created_at"],"updatedAt" to row["updated_at"],"createdBy" to "BNOC","revision" to row["revision"],"attachments" to db.attachmentMetadata("notice",row["notice_ref"] as String),"history" to db.rows("SELECT recorded_at,actor_subject FROM bnoc_operations_history WHERE resource_kind='notice' AND resource_ref=? ORDER BY recorded_at,history_ref",row["notice_ref"]).map { mapOf("at" to it["recorded_at"],"actorLabel" to "BNOC","field" to "공지 수정","summary" to "공지 제목·본문·첨부 저장") })
    fun access(actor:Actor):List<Map<String,Any?>> {
        if(!actor.accessAdmin || actor.role!="admin") reject("FORBIDDEN")
        return db.actors().map { a -> mapOf("subjectRef" to a.subjectRef,"displayName" to a.displayName,"role" to a.role,"department" to a.department,"teamId" to a.teamId,"departmentManager" to a.departmentManager,"active" to a.active,"revision" to a.revision) }
    }
    private fun changeAccess(actor:Actor,command:Command):CommandResult {
        val p=command.payload;val ref=text(p,"subjectRef",36,true);val target=db.actorByRef(ref,true) ?: reject("NOT_FOUND");revision(command,target.revision)
        val role=text(p,"role",32,true)
        if(role !in listOf("requester","bnoc","team","admin")) reject("VALIDATION",mapOf("role" to "역할을 확인하세요."))
        val manager=p["departmentManager"] as? Boolean ?: reject("VALIDATION");val active=p["active"] as? Boolean ?: reject("VALIDATION")
        val department=text(p,"department",100);val team=text(p,"teamId",100).ifBlank { null }
        if((department.isNotEmpty() && department !in db.departments) || (manager && department.isEmpty()) || (role=="team" && (team !in db.teams || department!=team)) || (role!="team" && team!=null) || (role=="admin" && manager)) reject("VALIDATION")
        if(target.id==actor.id && (role!=target.role || (manager && !target.departmentManager) || (active && !target.active) || team!=target.teamId)) reject("FORBIDDEN")
        val changed=target.role!=role || target.department!=department || target.teamId!=team || target.departmentManager!=manager || target.active!=active
        if(changed) {
            val label=when(role) { "bnoc" -> "BNOC";"team" -> team!!;"admin" -> "권한 관리자";else -> if(manager) "부서 담당자" else "일반 요청자" }
            db.jdbc.update("UPDATE bnoc_subjects SET role_name=?,display_label=?,department=?,team_id=?,department_manager=?,active=?,access_admin=?,revision=? WHERE subject_ref=?",role,label,department,team,manager,active,role=="admin",target.revision+1,ref)
            db.operationsHistory(actor,"access",ref,target.view(),db.actorByRef(ref)!!.view())
        }
        return CommandResult(publicRef=ref,revision=if(changed) target.revision+1 else target.revision)
    }
}
