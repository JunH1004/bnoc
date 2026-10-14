package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

class WorkflowContractTest {
    lateinit var db: Database
    lateinit var service: WorkflowService
    lateinit var requester: Actor
    lateinit var bnoc: Actor
    lateinit var team: Actor
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source)); db.initialize()
        service=WorkflowService(db, TransactionTemplate(DataSourceTransactionManager(source)))
        requester=db.actor("requester")!!;bnoc=db.actor("bnoc")!!;team=db.actor("team-wireless")!!
    }
    private fun op(type:String,number:String?=null,work:String?=null,revision:Long?=null,payload:Map<String,Any?> = emptyMap())=Command(type,UUID.randomUUID().toString(),number,work,revision,payload)
    private fun create():String = service.execute(requester,op("createRequest",payload=mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),"detail" to "지원 요청","location" to "신청 위치","contact" to "1234","scheduledAt" to "2026-10-14T00:00:00Z"))).requestNumber!!
    private fun assign(number:String)=service.execute(bnoc,op("assignTeams",number,revision=db.request(number)!!.revision,payload=mapOf("teamIds" to listOf("무선반"),"priority" to "urgent")))
    @Test fun `BNOC assignment must not set work schedule`() {
        val number=create();assign(number)
        assertNull(db.works(number).single().schedule,"BNOC_ASSIGNMENT_MUST_NOT_SET_SCHEDULE")
    }
    @Test fun `unclassified assignment is rejected before any work is created`() {
        val number=create()
        val failure=runCatching { service.execute(bnoc,op("assignTeams",number,revision=db.request(number)!!.revision,payload=mapOf("teamIds" to listOf("무선반")))) }.exceptionOrNull()
        assertTrue(failure is BusinessFailure,"ASSIGNMENT_CLASSIFICATION_REQUIRED")
        assertEquals("VALIDATION",(failure as BusinessFailure).code)
        assertTrue(db.works(number).isEmpty());assertNull(db.request(number)!!.priority)
    }
    @Test fun `BNOC may correct classification without changing work`() {
        val number=create();assign(number)
        val work=db.works(number).single();val before=work.copy()
        service.execute(bnoc,op("changePriority",number,revision=db.request(number)!!.revision,payload=mapOf("priority" to "general")))
        assertEquals("general",db.request(number)!!.priority)
        assertEquals(before,db.works(number).single())
        assertThrows(BusinessFailure::class.java) { service.execute(team,op("changePriority",number,revision=db.request(number)!!.revision,payload=mapOf("priority" to "urgent"))) }
    }
    @Test fun `unresolved returned work blocks requester edits and all assigned allows again`() {
        val number=create();assign(number);val work=db.works(number).single()
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인")))
        val failure=assertThrows(BusinessFailure::class.java) { service.execute(requester,op("updateRequest",number,revision=db.request(number)!!.revision,payload=mapOf("detail" to "수정 요청"))) }
        assertEquals("INVALID_STATE",failure.code,"UNRESOLVED_RETURN_MUST_BLOCK_REQUESTER_EDIT")
        service.execute(team,op("updateWork",number,work.number,db.work(work.number)!!.revision,mapOf("nextStatus" to "배정")))
        service.execute(requester,op("updateRequest",number,revision=db.request(number)!!.revision,payload=mapOf("detail" to "수정 요청")))
        assertEquals("수정 요청",db.request(number)!!.detail)
    }
    @Test fun `same submission executes once and changed submission is rejected`() {
        val command=op("createRequest",payload=mapOf("category" to "회의 지원","subcategories" to mapOf("meetingType" to "일반회의"),"detail" to "회의 지원","location" to "신청 위치","contact" to "1234"))
        val first=service.execute(requester,command);val second=service.execute(requester,command)
        assertEquals(first.requestNumber,second.requestNumber);assertEquals(true,second.replayed)
        assertEquals(1,db.requests().size)
        assertEquals("DUPLICATE_ACTION",assertThrows(BusinessFailure::class.java) { service.execute(requester,command.copy(payload=command.payload+mapOf("detail" to "다른 요청"))) }.code)
    }
}
