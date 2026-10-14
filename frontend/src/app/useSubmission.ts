import { useRef, useState } from 'react';
import type { RunCommand, CommandTarget } from '../screens/RequestRegistrationForm';
export function useSubmission(run: RunCommand) {
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const receipt = useRef<{ fingerprint: string; id: string } | null>(null);
  const submit = async (type: string, payload: Record<string, unknown>, target?: CommandTarget, revision?: number) => {
    if (submitting.current) return null;
    const fingerprint = JSON.stringify({ type, payload, target, revision });
    if (receipt.current?.fingerprint !== fingerprint) receipt.current = { fingerprint, id: crypto.randomUUID() };
    submitting.current = true; setSaving(true);
    try { return await run(type, payload, target, revision, receipt.current.id); }
    finally { submitting.current = false; setSaving(false); }
  };
  return { saving, submit };
}
