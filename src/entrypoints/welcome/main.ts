// The welcome page, opened once on install (src/background/welcome.ts). It only reads: it changes no
// setting and starts no check.
import { renderWelcome } from '../../ui/welcomeView';
import '../../ui/theme.css';
import './style.css';

document.getElementById('app')?.replaceChildren(renderWelcome(document));
