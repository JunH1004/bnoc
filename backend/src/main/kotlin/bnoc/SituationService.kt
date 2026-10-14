package bnoc

import jakarta.annotation.PostConstruct
import org.springframework.beans.factory.annotation.Value
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.UUID

@Service
class SituationService(val db:Database,val auth:AuthService,val transaction:TransactionTemplate,
    @param:Value("\${bnoc.gps.poll-ms}") val gpsPoll:Long,@param:Value("\${bnoc.cpcon.poll-ms}") val cpconPoll:Long,
    @param:Value("\${bnoc.gps.timeout-ms}") val gpsTimeout:Long,@param:Value("\${bnoc.cpcon.timeout-ms}") val cpconTimeout:Long,
    @param:Value("\${bnoc.gps.valid-seconds}") val gpsValid:Long,@param:Value("\${bnoc.cpcon.valid-seconds}") val cpconValid:Long,
    @param:Value("\${bnoc.cpcon.codes}") codes:String) {
    val cpconCodes=codes.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    val labels=mapOf("1" to "CPCONⅠ급","2" to "CPCONⅡ급","3" to "CPCONⅢ급","4" to "CPCONⅣ급","5" to "CPCONⅤ급")
    @PostConstruct fun validate() {
        check(listOf(gpsPoll,cpconPoll,gpsTimeout,cpconTimeout,gpsValid,cpconValid).all { it>0 }) { "수집 주기·시간 초과·유효시간은 양수여야 합니다." }
        check(cpconCodes.all { it in labels }) { "CPCON 사전을 확인하세요." }
    }
    @Scheduled(fixedDelayString="\${bnoc.gps.poll-ms}",initialDelayString="\${bnoc.gps.poll-ms}") fun collectGps()=collect("gps")
    @Scheduled(fixedDelayString="\${bnoc.cpcon.poll-ms}",initialDelayString="\${bnoc.cpcon.poll-ms}") fun collectCpcon()=collect("cpcon")
    fun collect(kind:String) {
        val at=Instant.now();val fallbackScope=if(kind=="gps") "unit" else db.rows("SELECT scope_key FROM bnoc_situation WHERE kind='cpcon' ORDER BY last_attempt DESC").firstOrNull()?.get("scope_key") as? String ?: "source"
        var scope=fallbackScope
        var payload:Map<*,*>?=null;var failure:String?=null
        if(kind=="cpcon" && cpconCodes.isEmpty()) failure="UNCONFIGURED"
        else {
            try {
                val response=auth.client.send(HttpRequest.newBuilder(URI("${auth.providerUrl}/feeds/$kind")).header("X-Mock-Key",auth.secret).timeout(Duration.ofMillis(if(kind=="gps") gpsTimeout else cpconTimeout)).GET().build(),HttpResponse.BodyHandlers.ofString())
                if(response.statusCode()!=200) failure="SOURCE_UNAVAILABLE"
                else {
                    val value=db.json.readValue(response.body(),Map::class.java)
                    val code=value["stageCode"] as? String
                    val observed=(value["observedAt"] as? String)?.let { runCatching { Instant.parse(it) }.getOrNull() }
                    val inputScope=value["scopeKey"] as? String
                    val expectedLabel=if(kind=="gps") if(code=="5") "양호" else "${code}단계" else labels[code]
                    failure=when {
                        value["kind"]!=kind || value["sourceMode"]!="simulation" -> "SOURCE_MISMATCH"
                        inputScope.isNullOrBlank() || inputScope.length>100 || (kind=="gps" && inputScope!="unit") -> "INVALID_SCOPE"
                        code==null || (kind=="gps" && code !in (1..5).map { it.toString() }) || (kind=="cpcon" && code !in cpconCodes) -> "INVALID_STAGE"
                        value["stageLabel"]!=expectedLabel -> "INVALID_STAGE_LABEL"
                        observed==null -> "INVALID_OBSERVED_AT"
                        observed.isAfter(at.plusSeconds(60)) -> "FUTURE_OBSERVED_AT"
                        else -> null
                    }
                    if(inputScope!=null && inputScope.isNotBlank() && inputScope.length<=100 && (kind!="gps" || inputScope=="unit")) scope=inputScope
                    if(failure==null) payload=value
                }
            } catch(error:java.net.http.HttpTimeoutException) { failure="TIMEOUT" }
            catch(error:Exception) { failure="SOURCE_UNAVAILABLE" }
        }
        val success=payload;val failureCode=failure
        transaction.execute {
            db.lockResource("situation:$kind:$scope")
            val existing=db.rows("SELECT * FROM bnoc_situation WHERE kind=? AND scope_key=?",kind,scope).firstOrNull()
            if(existing==null) db.jdbc.update("INSERT INTO bnoc_situation(kind,scope_key,collection_state) VALUES (?,?,?)",kind,scope,"not_collected")
            if(success!=null) db.jdbc.update("UPDATE bnoc_situation SET last_attempt=?,last_success=?,observed_at=?,stage_code=?,stage_label=?,source_mode=?,collection_state='ok',failure_code=NULL WHERE kind=? AND scope_key=?",at.toString(),Instant.now().toString(),Instant.parse(success["observedAt"] as String).toString(),success["stageCode"],success["stageLabel"],"simulation",kind,scope)
            else db.jdbc.update("UPDATE bnoc_situation SET last_attempt=?,collection_state=?,failure_code=? WHERE kind=? AND scope_key=?",at.toString(),if(failureCode=="UNCONFIGURED") "unconfigured" else "failed",failureCode,kind,scope)
            db.jdbc.update("INSERT INTO bnoc_situation_attempts VALUES (?,?,?,?,?,?)",UUID.randomUUID().toString(),kind,scope,at.toString(),success!=null,failureCode)
        }
    }
    fun snapshot(kind:String):Map<String,Any?> {
        if(kind !in listOf("gps","cpcon")) reject("NOT_FOUND")
        if(kind=="cpcon" && cpconCodes.isEmpty()) return mapOf("kind" to kind,"scopeKey" to null,"stageCode" to null,"stageLabel" to null,"observedAt" to null,"lastAttempt" to null,"lastSuccess" to null,"collectionState" to "unconfigured","failureCode" to "UNCONFIGURED","sourceMode" to "simulation")
        val row=db.rows("SELECT * FROM bnoc_situation WHERE kind=? ORDER BY last_attempt DESC,scope_key",kind).firstOrNull()
        if(row==null) return mapOf("kind" to kind,"scopeKey" to null,"stageCode" to null,"stageLabel" to null,"observedAt" to null,"lastAttempt" to null,"lastSuccess" to null,"collectionState" to "not_collected","failureCode" to null,"sourceMode" to "simulation")
        val observed=(row["observed_at"] as? String)?.let { Instant.parse(it) }
        val stale=observed!=null && !Instant.now().isBefore(observed.plusSeconds(if(kind=="gps") gpsValid else cpconValid))
        return mapOf("kind" to kind,"scopeKey" to row["scope_key"],"stageCode" to row["stage_code"],"stageLabel" to row["stage_label"],"observedAt" to row["observed_at"],"lastAttempt" to row["last_attempt"],"lastSuccess" to row["last_success"],"collectionState" to if(stale) "stale" else row["collection_state"],"failureCode" to row["failure_code"],"sourceMode" to (row["source_mode"] ?: "simulation"),"stale" to stale)
    }
}
