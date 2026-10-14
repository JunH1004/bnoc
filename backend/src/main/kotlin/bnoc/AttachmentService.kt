package bnoc

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.web.multipart.MultipartFile
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.scheduling.annotation.Scheduled
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant
import java.util.UUID
import java.util.zip.ZipInputStream

@Service
class AttachmentService(val db:Database,val query:QueryService,val transaction:TransactionTemplate,@param:Value("\${bnoc.file-root}") root:String) {
    private val root=Path.of(root).toAbsolutePath().normalize().also { Files.createDirectories(it) }
    private val extensions=setOf("pdf","doc","docx","hwp","hwpx","xls","xlsx","ppt","pptx","txt","png","jpg","jpeg")
    fun upload(actor:Actor,kind:String,file:MultipartFile):Map<String,Any?> {
        if(kind !in listOf("request","notice")) reject("VALIDATION")
        if(kind=="notice" && actor.role!="bnoc") reject("FORBIDDEN")
        if(kind=="request" && actor.role !in listOf("requester","bnoc","team")) reject("FORBIDDEN")
        val name=file.originalFilename ?: reject("VALIDATION",mapOf("attachments" to "파일명을 확인하세요."))
        if(name.isBlank() || name.length>255 || name.any { it=='/' || it=='\\' || it==':' || it=='\r' || it=='\n' || it=='\u0000' } || name in listOf(".","..")) reject("VALIDATION",mapOf("attachments" to "경로가 포함된 파일명은 사용할 수 없습니다."))
        val extension=name.substringAfterLast('.',"").lowercase()
        if(file.isEmpty || file.size>10L*1024*1024 || extension !in extensions) reject("VALIDATION",mapOf("attachments" to "지원하는 문서·이미지 파일은 10MiB까지 가능합니다."))
        val bytes=file.bytes
        if(!validFormat(extension,bytes)) reject("VALIDATION",mapOf("attachments" to "파일 확장자와 실제 형식이 일치하지 않습니다."))
        val ref=UUID.randomUUID().toString();val stored="$ref.bin";val target=root.resolve(stored)
        val contentType=when(extension) { "pdf"->"application/pdf";"png"->"image/png";"jpg","jpeg"->"image/jpeg";"txt"->"text/plain";else->"application/octet-stream" }
        Files.write(target,bytes,StandardOpenOption.CREATE_NEW)
        try { transaction.execute { db.jdbc.update("INSERT INTO bnoc_attachments VALUES (?,?,?,?,?,?,?,?,?,?,?)",ref,actor.id,kind,null,name,contentType,file.size,stored,Instant.now().toString(),false,false) } }
        catch(error:Exception) { Files.deleteIfExists(target);throw error }
        return mapOf("id" to ref,"fileName" to name,"size" to file.size,"type" to contentType)
    }
    fun validFormat(extension:String,bytes:ByteArray):Boolean {
        fun prefix(vararg values:Int)=bytes.size>=values.size && values.indices.all { (bytes[it].toInt() and 255)==values[it] }
        return when(extension) {
            "pdf" -> bytes.size>=8 && bytes.take(5).toByteArray().contentEquals("%PDF-".toByteArray())
            "png" -> prefix(137,80,78,71,13,10,26,10)
            "jpg","jpeg" -> prefix(255,216,255)
            "txt" -> runCatching { val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();text.none { it=='\u0000' || (it.code<32 && it !in "\t\r\n\u000c") } }.getOrDefault(false)
            "doc","xls","ppt","hwp" -> {
                if(!prefix(208,207,17,224,161,177,26,225)) false
                else {
                    val stream=when(extension) { "doc"->"WordDocument";"xls"->"Workbook";"ppt"->"PowerPoint Document";else->"FileHeader" }
                    val encoded=stream.toByteArray(Charsets.UTF_16LE)
                    contains(bytes,encoded) || (extension=="xls" && contains(bytes,"Book".toByteArray(Charsets.UTF_16LE)))
                }
            }
            "docx","xlsx","pptx","hwpx" -> {
                if(!prefix(80,75,3,4)) false else runCatching {
                    val names=mutableSetOf<String>();var total=0L;var count=0
                    ZipInputStream(bytes.inputStream()).use { zip ->
                        val buffer=ByteArray(8192)
                        while(true) {
                            val entry=zip.nextEntry ?: break
                            if(++count>10000 || entry.name.startsWith('/') || entry.name.split('/').contains("..")) return@runCatching false
                            names.add(entry.name)
                            while(true) { val read=zip.read(buffer);if(read<0) break;total+=read;if(total>100L*1024*1024) return@runCatching false }
                            zip.closeEntry()
                        }
                    }
                    if(extension=="hwpx") names.contains("mimetype") && names.any { it.startsWith("Contents/section") && it.endsWith(".xml") } && names.contains("Contents/content.hpf")
                    else names.contains("[Content_Types].xml") && names.contains(when(extension) { "docx"->"word/document.xml";"xlsx"->"xl/workbook.xml";else->"ppt/presentation.xml" })
                }.getOrDefault(false)
            }
            else -> false
        }
    }
    private fun contains(bytes:ByteArray,pattern:ByteArray):Boolean=bytes.indices.any { index -> index+pattern.size<=bytes.size && pattern.indices.all { offset -> bytes[index+offset]==pattern[offset] } }
    fun download(actor:Actor,ref:String):Pair<Map<String,Any?>,ByteArray> = transaction.execute {
        val row=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=?",ref).firstOrNull() ?: reject("NOT_FOUND")
        val resource=row["resource_ref"] as? String
        if(resource==null) reject("NOT_FOUND")
        else if(row["resource_kind"]=="request") query.requireRequest(actor,resource)
        else if(row["resource_kind"]=="notice") { if(db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_notices WHERE notice_ref=?",Int::class.java,resource)!=1) reject("NOT_FOUND") }
        else reject("NOT_FOUND")
        val path=root.resolve(row["stored_name"] as String).normalize()
        if(!path.startsWith(root) || !Files.isRegularFile(path)) reject("NOT_FOUND")
        row to Files.readAllBytes(path)
    }!!
    fun exists(storedName:String):Boolean { val file=root.resolve(storedName).normalize();return file.startsWith(root) && Files.isRegularFile(file) }
    @Scheduled(fixedDelay=3600000,initialDelay=3600000) fun cleanTemporary() {
        val names=transaction.execute {
            val rows=db.rows("SELECT attachment_ref,stored_name FROM bnoc_attachments WHERE resource_ref IS NULL AND was_linked=FALSE AND uploaded_at<? FOR UPDATE",Instant.now().minusSeconds(86400).toString())
            rows.forEach { db.jdbc.update("DELETE FROM bnoc_attachments WHERE attachment_ref=? AND resource_ref IS NULL AND was_linked=FALSE",it["attachment_ref"]) }
            rows.map { it["stored_name"] as String }
        } ?: emptyList()
        names.forEach { name -> runCatching { val file=root.resolve(name).normalize();if(file.startsWith(root)) Files.deleteIfExists(file) } }
    }
}
