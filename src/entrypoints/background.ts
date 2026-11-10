import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from '../background/hub';
import { openWelcomeOnInstall } from '../background/welcome';

// Listeners must be registered synchronously on startup: the service worker is woken for an event
// only if its handler exists when the script first runs.
export default defineBackground(() => {
  startBackground();
  openWelcomeOnInstall();
});
