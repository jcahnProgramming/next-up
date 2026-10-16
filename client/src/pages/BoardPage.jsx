import { useParams } from 'react-router-dom';
import { ComingSoon } from './ComingSoon.jsx';

// /b/:code: boards aren't built yet. It never looks the code up or implies a board exists: it only repeats what
// was typed, as text.
export function BoardPage() {
  const { code } = useParams();
  return (
    <ComingSoon feature="Boards are coming soon">
      Next Up can't open or create boards yet, so nothing has been looked up, created or saved for the code “{code}”.
    </ComingSoon>
  );
}
