package bnoc

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import jakarta.annotation.PostConstruct
import org.springframework.beans.factory.annotation.Value
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.util.UUID

@Repository
class Database(val jdbc:JdbcTemplate,@param:Value("\${bnoc.bootstrap-admin:access-admin}") private val bootstrapAdmin:String="access-admin",@param:Value("\${bnoc.integration-mode:competition}") private val integrationMode:String="competition",@param:Value("\${bnoc.departments:}") private val additionalDepartments:String="") {
    val json=jacksonObjectMapper()
    val teams=listOf("무선반","유선반","전장반(전산장비)","정체반","암호반")
    val departments get()=rows("SELECT department FROM bnoc_departments ORDER BY sort_order,department").map { it["department"] as String }
    fun rows(sql:String,vararg args:Any?):List<Map<String,Any?>> = jdbc.queryForList(sql,*args).map { row -> row.entries.associate { it.key.lowercase() to it.value } }
    @PostConstruct fun initialize() {
        check(integrationMode=="competition") { "실제 연동 구현 없는 운영 모드에서 모의 계정·업무 저장소를 초기화하지 않습니다." }
        check(bootstrapAdmin.isNotBlank() && bootstrapAdmin.length<=128) { "최초 관리자 외부 식별자를 확인하세요." }
        val configuredDepartments=if(additionalDepartments.isBlank()) emptyList() else additionalDepartments.split(',').map { it.trim() }
        check(configuredDepartments.all { it.isNotEmpty() && it.length<=100 && it.none { char -> char.isISOControl() || char=='|' } }) { "추가 부서명은 1~100자여야 하며 빈 항목·제어 문자·구분자를 포함할 수 없습니다." }
        listOf(
            "CREATE TABLE IF NOT EXISTS bnoc_sequences (sequence_key VARCHAR(64) PRIMARY KEY,sequence_value BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bnoc_subjects (subject_id VARCHAR(128) PRIMARY KEY,role_name VARCHAR(32) NOT NULL,display_label VARCHAR(200) NOT NULL,department VARCHAR(100) NOT NULL,team_id VARCHAR(100),active BOOLEAN NOT NULL,subject_ref VARCHAR(36) NOT NULL UNIQUE,department_manager BOOLEAN NOT NULL,access_admin BOOLEAN NOT NULL,revision BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bnoc_departments (department VARCHAR(100) PRIMARY KEY,sort_order INT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bnoc_requests (request_number VARCHAR(40) PRIMARY KEY,requester_subject VARCHAR(128),requester_display_text VARCHAR(500) NOT NULL,registered_by VARCHAR(128) NOT NULL,category VARCHAR(100) NOT NULL,subcategories TEXT NOT NULL,detail TEXT NOT NULL,location VARCHAR(500) NOT NULL,contact VARCHAR(200) NOT NULL,equipment_id VARCHAR(200),maintenance_target TEXT,requested_schedule VARCHAR(64),document_ref VARCHAR(500),status VARCHAR(32) NOT NULL,registered_at VARCHAR(64) NOT NULL,updated_at VARCHAR(64) NOT NULL,revision BIGINT NOT NULL,priority VARCHAR(16),assigned_at VARCHAR(64))",
            "CREATE TABLE IF NOT EXISTS bnoc_works (work_number VARCHAR(48) PRIMARY KEY,request_number VARCHAR(40) NOT NULL,team_id VARCHAR(100) NOT NULL,status VARCHAR(32) NOT NULL,schedule VARCHAR(64),memo TEXT,return_reason TEXT,completion TEXT,resolved_by TEXT NOT NULL,replaces_work_number VARCHAR(48),origin VARCHAR(32) NOT NULL,revision BIGINT NOT NULL,assigned_person_refs TEXT NOT NULL,assigned_at VARCHAR(64),FOREIGN KEY(request_number) REFERENCES bnoc_requests(request_number))",
            "CREATE TABLE IF NOT EXISTS bnoc_history (history_id VARCHAR(36) PRIMARY KEY,request_number VARCHAR(40) NOT NULL,work_number VARCHAR(48),actor_subject VARCHAR(128) NOT NULL,recorded_at VARCHAR(64) NOT NULL,field_name VARCHAR(100) NOT NULL,before_value TEXT,after_value TEXT,FOREIGN KEY(request_number) REFERENCES bnoc_requests(request_number))",
            "CREATE TABLE IF NOT EXISTS bnoc_notifications (notification_id VARCHAR(36) PRIMARY KEY,recipient_subject VARCHAR(128) NOT NULL,event_name VARCHAR(100) NOT NULL,request_number VARCHAR(40) NOT NULL,work_number VARCHAR(48),recorded_at VARCHAR(64) NOT NULL,is_read BOOLEAN NOT NULL,FOREIGN KEY(request_number) REFERENCES bnoc_requests(request_number))",
            "CREATE TABLE IF NOT EXISTS bnoc_operation_locks (actor_subject VARCHAR(128) NOT NULL,operation_id VARCHAR(128) NOT NULL,PRIMARY KEY(actor_subject,operation_id))",
            "CREATE TABLE IF NOT EXISTS bnoc_receipts (actor_subject VARCHAR(128) NOT NULL,operation_id VARCHAR(128) NOT NULL,fingerprint VARCHAR(64) NOT NULL,request_number VARCHAR(40),command_type VARCHAR(100) NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(actor_subject,operation_id))",
            "CREATE TABLE IF NOT EXISTS bnoc_attachments (attachment_ref VARCHAR(36) PRIMARY KEY,owner_subject VARCHAR(128) NOT NULL,resource_kind VARCHAR(16) NOT NULL,resource_ref VARCHAR(40),file_name VARCHAR(255) NOT NULL,content_type VARCHAR(150) NOT NULL,byte_size BIGINT NOT NULL,stored_name VARCHAR(80) NOT NULL,uploaded_at VARCHAR(64) NOT NULL,was_linked BOOLEAN NOT NULL,current_link BOOLEAN NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bnoc_notices (notice_ref VARCHAR(36) PRIMARY KEY,title VARCHAR(300) NOT NULL,body TEXT NOT NULL,created_by VARCHAR(128) NOT NULL,created_at VARCHAR(64) NOT NULL,revision BIGINT NOT NULL,updated_at VARCHAR(64) NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bnoc_roster_versions (department VARCHAR(100) PRIMARY KEY,revision BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bnoc_roster (person_ref VARCHAR(36) PRIMARY KEY,department VARCHAR(100) NOT NULL,display_name VARCHAR(100) NOT NULL,active BOOLEAN NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bnoc_personnel (department VARCHAR(100) NOT NULL,record_date VARCHAR(10) NOT NULL,revision BIGINT NOT NULL,records_json MEDIUMTEXT NOT NULL,saved_by VARCHAR(128) NOT NULL,saved_at VARCHAR(64) NOT NULL,PRIMARY KEY(department,record_date))",
            "CREATE TABLE IF NOT EXISTS bnoc_night_duty (department VARCHAR(100) NOT NULL,record_date VARCHAR(10) NOT NULL,revision BIGINT NOT NULL,records_json MEDIUMTEXT NOT NULL,saved_by VARCHAR(128) NOT NULL,saved_at VARCHAR(64) NOT NULL,PRIMARY KEY(department,record_date))",
            "CREATE TABLE IF NOT EXISTS bnoc_resource_locks (resource_key VARCHAR(220) PRIMARY KEY)",
            "CREATE TABLE IF NOT EXISTS bnoc_operations_history (history_ref VARCHAR(36) PRIMARY KEY,resource_kind VARCHAR(32) NOT NULL,resource_ref VARCHAR(220) NOT NULL,actor_subject VARCHAR(128) NOT NULL,recorded_at VARCHAR(64) NOT NULL,before_json MEDIUMTEXT,after_json MEDIUMTEXT)",
            "CREATE TABLE IF NOT EXISTS bnoc_situation (kind VARCHAR(16) NOT NULL,scope_key VARCHAR(100) NOT NULL,last_attempt VARCHAR(64),last_success VARCHAR(64),observed_at VARCHAR(64),stage_code VARCHAR(32),stage_label VARCHAR(100),source_mode VARCHAR(32),collection_state VARCHAR(32) NOT NULL,failure_code VARCHAR(100),PRIMARY KEY(kind,scope_key))",
            "CREATE TABLE IF NOT EXISTS bnoc_situation_attempts (attempt_ref VARCHAR(36) PRIMARY KEY,kind VARCHAR(16) NOT NULL,scope_key VARCHAR(100) NOT NULL,attempted_at VARCHAR(64) NOT NULL,succeeded BOOLEAN NOT NULL,failure_code VARCHAR(100))"
        ).forEach { jdbc.execute(it) }
        if(jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_sequences WHERE sequence_key='request'",Int::class.java)==0) jdbc.update("INSERT INTO bnoc_sequences VALUES ('request',100)")
        (listOf("BNOC")+teams+configuredDepartments).distinct().forEachIndexed { index,department -> if(jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_departments WHERE department=?",Int::class.java,department)==0) jdbc.update("INSERT INTO bnoc_departments VALUES (?,?)",department,index) }
        val actors=listOf(Actor("requester","requester","일반 요청자",""),Actor("requester-secondary","requester","일반 요청자",""),
            Actor("bnoc","bnoc","BNOC","BNOC",departmentManager=true),Actor("bnoc-secondary","bnoc","BNOC","BNOC",departmentManager=true),
            Actor("department-manager","requester","부서 담당자","BNOC",departmentManager=true),Actor(bootstrapAdmin,"admin","권한 관리자","",accessAdmin=true)) + teams.mapIndexed { index,team -> Actor(listOf("team-wireless","team-wired","team-display","team-info","team-crypto")[index],"team",team,team,team,departmentManager=true) }
        actors.forEach { a -> if(actor(a.id)==null) jdbc.update("INSERT INTO bnoc_subjects VALUES (?,?,?,?,?,?,?,?,?,?)",a.id,a.role,a.displayName,a.department,a.teamId,a.active,UUID.randomUUID().toString(),a.departmentManager,a.accessAdmin,1) }
    }
    fun actor(subject:String,lock:Boolean=false):Actor?=jdbc.query("SELECT * FROM bnoc_subjects WHERE subject_id=?"+(if(lock) " FOR UPDATE" else ""),{ rs,_ -> mapActor(rs) },subject).firstOrNull()
    fun actorByRef(ref:String,lock:Boolean=false):Actor?=jdbc.query("SELECT * FROM bnoc_subjects WHERE subject_ref=?"+(if(lock) " FOR UPDATE" else ""),{ rs,_ -> mapActor(rs) },ref).firstOrNull()
    fun actors():List<Actor> = jdbc.query("SELECT * FROM bnoc_subjects ORDER BY role_name,subject_ref",{ rs,_ -> mapActor(rs) })
    private fun mapActor(rs:ResultSet)=Actor(rs.getString("subject_id"),rs.getString("role_name"),rs.getString("display_label"),rs.getString("department"),rs.getString("team_id"),rs.getBoolean("active"),rs.getString("subject_ref"),rs.getBoolean("department_manager"),rs.getBoolean("access_admin"),rs.getLong("revision"))
    fun request(number:String,lock:Boolean=false):RequestRecord?=jdbc.query("SELECT * FROM bnoc_requests WHERE request_number=?"+(if(lock) " FOR UPDATE" else ""),{ rs,_ -> mapRequest(rs) },number).firstOrNull()?.also { it.attachments=attachmentMetadata("request",number) }
    fun requests():List<RequestRecord> = jdbc.query("SELECT * FROM bnoc_requests ORDER BY updated_at DESC,request_number DESC",{ rs,_ -> mapRequest(rs) })
    private fun mapRequest(rs:ResultSet)=RequestRecord(rs.getString("request_number"),rs.getString("requester_subject"),rs.getString("requester_display_text"),rs.getString("registered_by"),rs.getString("category"),json.readValue(rs.getString("subcategories")),rs.getString("detail"),rs.getString("location"),rs.getString("contact"),rs.getString("equipment_id"),rs.getString("maintenance_target")?.let { json.readValue(it) },rs.getString("requested_schedule"),rs.getString("document_ref"),emptyList(),rs.getString("status"),rs.getString("registered_at"),rs.getString("updated_at"),rs.getLong("revision"),rs.getString("priority"),rs.getString("assigned_at"))
    fun works(number:String):List<WorkRecord> = jdbc.query("SELECT * FROM bnoc_works WHERE request_number=? ORDER BY work_number",{ rs,_ -> mapWork(rs) },number)
    fun work(number:String,lock:Boolean=false):WorkRecord?=jdbc.query("SELECT * FROM bnoc_works WHERE work_number=?"+(if(lock) " FOR UPDATE" else ""),{ rs,_ -> mapWork(rs) },number).firstOrNull()
    fun allWorks():List<WorkRecord> = jdbc.query("SELECT * FROM bnoc_works ORDER BY work_number",{ rs,_ -> mapWork(rs) })
    private fun mapWork(rs:ResultSet)=WorkRecord(rs.getString("work_number"),rs.getString("request_number"),rs.getString("team_id"),rs.getString("status"),rs.getString("schedule"),rs.getString("memo"),rs.getString("return_reason"),rs.getString("completion")?.let { json.readValue(it) },json.readValue(rs.getString("resolved_by")),rs.getString("replaces_work_number"),rs.getString("origin"),rs.getLong("revision"),json.readValue(rs.getString("assigned_person_refs")),rs.getString("assigned_at"))
    fun nextNumber():String {
        val last=jdbc.queryForObject("SELECT sequence_value FROM bnoc_sequences WHERE sequence_key='request' FOR UPDATE",Long::class.java)!!
        jdbc.update("UPDATE bnoc_sequences SET sequence_value=? WHERE sequence_key='request'",last+1);return (last+1).toString()
    }
    fun insertRequest(r:RequestRecord)=jdbc.update("INSERT INTO bnoc_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",r.number,r.requesterSubject,r.requesterDisplayText,r.registeredBy,r.category,json.writeValueAsString(r.subcategories),r.detail,r.location,r.contact,r.equipmentId,r.maintenanceTarget?.let { json.writeValueAsString(it) },r.scheduledAt,r.documentRef,r.status,r.registeredAt,r.updatedAt,r.revision,r.priority,r.assignedAt)
    fun saveRequest(r:RequestRecord)=jdbc.update("UPDATE bnoc_requests SET detail=?,location=?,contact=?,requested_schedule=?,document_ref=?,status=?,updated_at=?,revision=?,priority=?,assigned_at=? WHERE request_number=?",r.detail,r.location,r.contact,r.scheduledAt,r.documentRef,r.status,r.updatedAt,r.revision,r.priority,r.assignedAt,r.number)
    fun insertWork(w:WorkRecord)=jdbc.update("INSERT INTO bnoc_works VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",w.number,w.requestNumber,w.teamId,w.status,w.schedule,w.memo,w.returnReason,w.completion?.let { json.writeValueAsString(it) },json.writeValueAsString(w.resolvedBy),w.replaces,w.origin,w.revision,json.writeValueAsString(w.assignedPersonRefs),w.assignedAt)
    fun saveWork(w:WorkRecord)=jdbc.update("UPDATE bnoc_works SET status=?,schedule=?,memo=?,return_reason=?,completion=?,resolved_by=?,revision=?,assigned_person_refs=? WHERE work_number=?",w.status,w.schedule,w.memo,w.returnReason,w.completion?.let { json.writeValueAsString(it) },json.writeValueAsString(w.resolvedBy),w.revision,json.writeValueAsString(w.assignedPersonRefs),w.number)
    fun attachmentMetadata(kind:String,ref:String):List<Map<String,Any?>> = rows("SELECT attachment_ref,file_name,byte_size,content_type FROM bnoc_attachments WHERE resource_kind=? AND resource_ref=? AND current_link=TRUE ORDER BY uploaded_at,attachment_ref",kind,ref).map { mapOf("id" to it["attachment_ref"],"fileName" to it["file_name"],"size" to it["byte_size"],"type" to it["content_type"]) }
    fun lockResource(key:String) {
        jdbc.update("INSERT INTO bnoc_resource_locks(resource_key) VALUES (?) ON DUPLICATE KEY UPDATE resource_key=VALUES(resource_key)",key)
        jdbc.queryForObject("SELECT resource_key FROM bnoc_resource_locks WHERE resource_key=? FOR UPDATE",String::class.java,key)
    }
    fun operationsHistory(actor:Actor,kind:String,ref:String,before:Any?,after:Any?)=jdbc.update("INSERT INTO bnoc_operations_history VALUES (?,?,?,?,?,?,?)",UUID.randomUUID().toString(),kind,ref,actor.id,java.time.Instant.now().toString(),before?.let { json.writeValueAsString(it) },after?.let { json.writeValueAsString(it) })
}
