// Presentation only: Chessground remains responsible for drag thresholds, hit
// testing, orientation, and move submission. Mouse input is left unchanged.
export function initTouchDrag(board, ground) {
  const target = document.createElement('div');
  target.className = 'touch-drag-target';
  target.hidden = true;
  target.setAttribute('aria-hidden', 'true');
  board.append(target);
  let frame = null;

  function clear() {
    cancelAnimationFrame(frame);
    frame = null;
    board.classList.remove('touch-dragging');
    target.hidden = true;
  }

  function update() {
    const drag = ground.state.draggable.current;
    if (!drag) { clear(); return; }
    board.classList.toggle('touch-dragging', drag.started);
    const key = drag.started && ground.getKeyAtDomPos(drag.pos);
    // Orientation changes rebuild Chessground's DOM, including our overlay.
    if (target.parentElement !== board) board.append(target);
    target.hidden = !key;
    if (key) {
      const white = ground.state.orientation === 'white';
      const file = key.charCodeAt(0) - 97;
      const rank = Number(key[1]) - 1;
      target.style.left = `${((white ? file : 7 - file) + 0.5) * 12.5}%`;
      target.style.top = `${((white ? 7 - rank : rank) + 0.5) * 12.5}%`;
    }
    frame = requestAnimationFrame(update);
  }

  board.addEventListener('touchstart', (event) => {
    clear();
    // Wait until Chessground has processed the touch; taps don't get enlarged.
    if (event.touches.length === 1) frame = requestAnimationFrame(update);
  }, { capture: true, passive: true });
  document.addEventListener('touchend', clear, { passive: true });
  document.addEventListener('touchcancel', () => {
    ground.cancelMove();
    clear();
  }, { passive: true });
  window.addEventListener('blur', clear);
}
