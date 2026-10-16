'use strict';
// Fits a window into the usable area of a display (Bug Log #92).
//
// The Display & HUD window (which also carries first-run set-up) asked for a
// fixed 1180×840 with a 960×620 minimum. On a 1366×768 laptop the work area is
// about 1366×720, and at 150% scaling it is about 911×480 DIPs, so the bottom
// of the window, and at 150% its right side too, ended up off-screen or under
// the taskbar. The requested size is now a preference: it is shrunk, minimums
// included, to fit the work area with a small margin, and centred there.

const MARGIN = 16;

/**
 * @param {{width:number,height:number,minWidth:number,minHeight:number}} want  preferred size, DIPs
 * @param {{x:number,y:number,width:number,height:number}} workArea  display work area, DIPs
 * @returns {{x:number,y:number,width:number,height:number,minWidth:number,minHeight:number}}
 */
function fitToWorkArea(want, workArea, margin = MARGIN) {
  const maxW = Math.max(200, workArea.width - 2 * margin);
  const maxH = Math.max(200, workArea.height - 2 * margin);
  const width = Math.round(Math.min(want.width, maxW));
  const height = Math.round(Math.min(want.height, maxH));
  return {
    width,
    height,
    minWidth: Math.min(want.minWidth, width),
    minHeight: Math.min(want.minHeight, height),
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

module.exports = { fitToWorkArea, MARGIN };
