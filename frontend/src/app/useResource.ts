import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { ApiError } from '../api/apiClient.mjs';

export function useResource<T, C = undefined>(load: (signal: AbortSignal) => Promise<T>, dependencies: DependencyList, context?: C) {
  const [success, setSuccess] = useState<{ data: T; context: C | undefined; confirmedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    Promise.resolve(load(controller.signal)).then(value => { if (!controller.signal.aborted) setSuccess({ data: value, context, confirmedAt: new Date().toISOString() }); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason : new Error('조회하지 못했습니다.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [...dependencies, retry]);
  const reload = useCallback(() => setRetry(value => value + 1), []);
  return { data: success?.data ?? null, success, loading, error, reload };
}

export function errorMessage(error: ApiError | Error | null) {
  if (!error) return '';
  if (error instanceof ApiError && (error.status === 401 || error.code === 'UNAUTHENTICATED')) return '로그인이 만료됐습니다. 다시 로그인하세요. 입력 내용은 유지됩니다.';
  if (error instanceof ApiError && error.code === 'FORBIDDEN') return '이 내용을 조회할 권한이 없습니다.';
  if (error instanceof ApiError && error.code === 'NOT_FOUND') return '찾을 수 없거나 조회 권한이 없습니다.';
  return error.message || '조회하지 못했습니다. 다시 시도하세요.';
}
