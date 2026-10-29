import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { Effects } from './Effects.jsx';
import { Colors } from './Colors.jsx';
import { Background } from './Background.jsx';

/**
 * The view the app opens on: the room as the rig paints it and the looks to
 * pick from beside it. The switches a party needs — armed or not, what paints
 * the room, the auto show on or off, blackout, the master — are on the strip
 * the shell keeps above every live view (Strip.jsx).
 */
export function Show() {
  return (
    <div class="show-view">
      <StrobesOff perform />
      <div class="show-body">
        <div class="show-room"><StageView compact /></div>
        <div class="show-looks"><Effects /><Colors /><Background /></div>
      </div>
    </div>
  );
}
