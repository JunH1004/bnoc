export function dailyPersonnelEntries(entries,draft) {
  return entries.map(entry => ({ personRef:entry.personRef,status:draft && Object.hasOwn(draft,entry.personRef) ? draft[entry.personRef] : entry.status })).filter(entry => entry.status != null && entry.status !== '');
}
export function currentOperationalResource(result,key,value) { return !result.loading && !result.error && result.data?.[key] === value; }
