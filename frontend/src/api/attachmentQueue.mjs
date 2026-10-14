export async function uploadAttachmentBatch(files,upload,getCurrent) {
  const uploaded=[],failures=[];
  for(const file of files) {
    try { uploaded.push(await upload(file)); }
    catch(error) { failures.push({ file,error:error instanceof Error ? error : new Error('파일을 올리지 못했습니다.') }); }
  }
  if(uploaded.length) { const current=getCurrent();current.onChange([...current.files,...uploaded]); }
  return failures;
}
export function attachmentSubmissionBlocked(busy,failures) { return busy || failures.length > 0; }
