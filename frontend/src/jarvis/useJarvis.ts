import { useStore } from '../store';
import { postJarvisChat } from '../api';
import { toApiMessages } from './history';
import type { useTts } from '../voice/useTts';

/** 자비스 대화 전송. Phase 1 은 잡담 응답만 표시·낭독. (delegate 처리는 App 측 Phase 2에서 주입) */
export function useJarvis(tts: ReturnType<typeof useTts>, onDelegate?: (task: string, agent?: string) => void) {
  const pushJarvisTurn = useStore((s) => s.pushJarvisTurn);
  const setJarvisBusy = useStore((s) => s.setJarvisBusy);

  async function send(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    pushJarvisTurn({ role: 'user', text: t });
    setJarvisBusy(true);
    try {
      const history = toApiMessages(useStore.getState().jarvisTurns);
      const out = await postJarvisChat(history);
      pushJarvisTurn({ role: 'jarvis', text: out.reply });
      tts.speak(out.reply, useStore.getState().jarvisTurns.length); // 보고 턴 낭독
      if (out.delegate?.task && onDelegate) onDelegate(out.delegate.task, out.delegate.agent);
    } catch (e) {
      pushJarvisTurn({ role: 'jarvis', text: `(오류) ${(e as Error).message}` });
    } finally {
      setJarvisBusy(false);
    }
  }
  return { send };
}
