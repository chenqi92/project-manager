// 页面上下文里用生物识别解锁金库（绝不能在 popup 里调用）。
import { toB64 } from './crypto';
import { api } from './messaging';
import { evaluatePrfForAny } from './webauthn';

export async function biometricUnlock(): Promise<void> {
  const enrollments = await api.bioEnrollments();
  if (enrollments.length === 0) throw new Error('尚未注册生物识别');
  const { enrollmentId, prfOutput } = await evaluatePrfForAny(enrollments);
  await api.unlockWithPrf(enrollmentId, toB64(prfOutput));
}
