import { initials, markBroken, useLogo } from './logos.js';

/**
 * A card (design/v1 Card-Anatomy, Card-States): a wide pill with the game's logo behind a scrim, or, with no logo,
 * a solid fill from the theme's --card-fb-* tokens with the name and a monogram disc.
 *
 * In a lane it is role="button" tabindex="0" (it holds block layout, which <button> may not): click or Enter opens
 * its panel; dragging it, a long press on a touch screen, or Space then arrows moves it (useCardDrag.js, given as
 * `dnd`; `describedBy` points at the instructions). Nothing clickable sits inside it yet; anything that ever does
 * must sit above this whole-card target (CLAUDE.md, "Bugs that cost us").
 */
export function CardPill({ card, onOpen, dnd, lifted = false, describedBy }) {
  const onKeyDown = (e) => {
    if (dnd?.onKeyDown(e, card)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(card);
    }
  };
  return (
    <CardFace
      card={card}
      className={lifted ? 'is-lifted' : ''}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-describedby={describedBy}
      onClick={() => onOpen(card)}
      onKeyDown={onKeyDown}
      onPointerDown={dnd ? (e) => dnd.onPointerDown(e, card) : undefined}
      data-card-id={card.id}
    />
  );
}

/** The card's look, without behaviour: the lane pill, or (with `header`) the larger one heading its panel. */
export function CardFace({ card, header = false, titleAs: Title = 'span', titleId, children, className = '', ...rest }) {
  const logo = useLogo(card.logo);
  return (
    <div className={`card${logo ? '' : ' is-fb'}${header ? ' card-header' : ''} ${className}`} {...rest}>
      {logo ? (
        <>
          <img className="card-art" src={logo.url} alt="" draggable="false" onError={() => markBroken(logo.url)} />
          <div className="card-scrim" />
        </>
      ) : (
        <span className="fb-mark" aria-hidden="true">
          {initials(card.title)}
        </span>
      )}
      <div className="card-body">
        <Title className="card-title" id={titleId}>
          {card.title}
        </Title>
        {children}
      </div>
    </div>
  );
}

/** The small pill in the logo dropdown and field (design/v1 .lcb-thumb): the logo, or the no-logo fill. */
export function LogoThumb({ logoId, title }) {
  const logo = useLogo(logoId);
  if (!logo) {
    return (
      <span className="lcb-thumb is-fb" aria-hidden="true">
        {initials(title)}
      </span>
    );
  }
  return (
    <span className="lcb-thumb" aria-hidden="true">
      <img src={logo.url} alt="" draggable="false" onError={() => markBroken(logo.url)} />
    </span>
  );
}
