package bnoc

object RequestStatus {
    fun derive(request: RequestRecord, works: List<WorkRecord>): String {
        if (request.status == "취소" || request.status == "문서 대기") return request.status
        val valid = works.filter { it.status != "반환" }
        if (valid.any { it.status == "작업 중" }) return "작업 중"
        if (works.any { it.status == "반환" && it.resolvedBy.isEmpty() }) return "대기"
        if (valid.isNotEmpty() && valid.all { it.status == "완료" }) return "완료"
        return if (valid.isNotEmpty()) "배정" else "대기"
    }
}
