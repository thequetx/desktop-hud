import { useEffect, useState } from 'react';
import { hudInitiallyShown, onHudShown } from './shell';

/** Whether this corner's HUD is on screen: the main process's hud:shown (a
 *  window created while hidden can't tell on its own) and the page's own
 *  visibility, which turns hidden once the window is hidden. */
export function useHudShown(): boolean {
  const [told, setTold] = useState(hudInitiallyShown);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    const off = onHudShown((s) => {
      setTold(s);
      if (s) onVis();
    });
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      off();
    };
  }, []);
  return told && visible;
}
