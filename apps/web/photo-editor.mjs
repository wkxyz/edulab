import {clamp, cropBounds, selectionFromPoints} from './ui.mjs';

// Work entirely in the browser. Only the confirmed image is submitted to the server.
export async function editPhoto(source) {
  const image = new Image();
  image.src = source;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('无法读取图片，请重新选择。');
  const previousFocus = document.activeElement;
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'crop-dialog';
    dialog.setAttribute('aria-labelledby', 'crop-title');
    dialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">选好一道题</span><h2 id="crop-title">调整题目图片</h2></div><button class="icon-button" data-close aria-label="关闭裁剪">×</button></div>
      <p class="muted" id="crop-help">拖动四角调整边框，拖动框内移动。保留题干、条件和图形。</p>
      <div class="crop-stage"><canvas class="crop-canvas" tabindex="0" aria-label="裁剪区域，方向键移动，按住 Shift 调整大小" aria-describedby="crop-help"></canvas></div>
      <div class="crop-tools"><button class="small-button" data-rotate>旋转 90°</button><button class="small-button" data-reset>重置选区</button><span class="muted" data-size></span></div>
      <p class="error" data-error hidden role="alert"></p><div class="dialog-actions"><button class="btn outline" data-cancel>取消</button><button class="btn" data-apply>使用这张图片</button></div>`;
    document.body.append(dialog);
    const canvas = dialog.querySelector('canvas'), ctx = canvas.getContext('2d');
    const base = document.createElement('canvas'), baseCtx = base.getContext('2d');
    let turns = 0, selection = {x: 0, y: 0, width: 1, height: 1}, gesture, finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      dialog.close(); dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
      resolve(value);
    };
    function drawImage() {
      const ratio = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
      const w = Math.max(1, Math.round(image.naturalWidth * ratio)), h = Math.max(1, Math.round(image.naturalHeight * ratio));
      base.width = turns % 2 ? h : w; base.height = turns % 2 ? w : h;
      baseCtx.fillStyle = '#fff'; baseCtx.fillRect(0, 0, base.width, base.height);
      baseCtx.save(); baseCtx.translate(base.width / 2, base.height / 2); baseCtx.rotate(turns * Math.PI / 2);
      baseCtx.drawImage(image, -w / 2, -h / 2, w, h); baseCtx.restore();
      const previewScale = Math.min(1, 1100 / Math.max(base.width, base.height));
      canvas.width = Math.max(1, Math.round(base.width * previewScale));
      canvas.height = Math.max(1, Math.round(base.height * previewScale));
      selection = {x: 0, y: 0, width: 1, height: 1}; paint();
    }
    function paint() {
      const {width: w, height: h} = canvas;
      const x = selection.x * w, y = selection.y * h, sw = selection.width * w, sh = selection.height * h;
      ctx.clearRect(0, 0, w, h); ctx.drawImage(base, 0, 0, w, h);
      ctx.fillStyle = 'rgba(12, 28, 23, .55)'; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, sw, sh); ctx.clip(); ctx.drawImage(base, 0, 0, w, h); ctx.restore();
      ctx.strokeStyle = '#33d4a0'; ctx.lineWidth = Math.max(2, w / 350); ctx.strokeRect(x + 1, y + 1, Math.max(0, sw - 2), Math.max(0, sh - 2));
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(x + sw * i / 3, y); ctx.lineTo(x + sw * i / 3, y + sh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y + sh * i / 3); ctx.lineTo(x + sw, y + sh * i / 3); ctx.stroke();
      }
      const handle = Math.max(8, w / 65); ctx.fillStyle = '#fff';
      for (const [hx, hy] of [[x,y],[x+sw,y],[x,y+sh],[x+sw,y+sh]]) ctx.fillRect(clamp(hx-handle/2,0,w-handle),clamp(hy-handle/2,0,h-handle),handle,handle);
      dialog.querySelector('[data-size]').textContent = `${Math.round(selection.width * base.width)} × ${Math.round(selection.height * base.height)}`;
    }
    const point = event => {
      const r = canvas.getBoundingClientRect();
      return {x: clamp((event.clientX - r.left) / r.width), y: clamp((event.clientY - r.top) / r.height)};
    };
    canvas.onpointerdown = event => {
      event.preventDefault(); canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = point(event), r = selection, bounds = canvas.getBoundingClientRect();
      const corners = [[r.x,r.y,'nw'],[r.x+r.width,r.y,'ne'],[r.x,r.y+r.height,'sw'],[r.x+r.width,r.y+r.height,'se']];
      const corner = corners.find(([x,y]) => Math.abs(p.x-x)*bounds.width < 24 && Math.abs(p.y-y)*bounds.height < 24);
      const inside = p.x >= r.x && p.x <= r.x+r.width && p.y >= r.y && p.y <= r.y+r.height;
      gesture = {start:p, rect:{...r}, mode:corner?.[2] || (inside ? 'move' : 'new')};
    };
    canvas.onpointermove = event => {
      if (!gesture) return;
      const p = point(event), {rect:r, start, mode} = gesture;
      if (mode === 'move') selection = {...r, x:clamp(r.x+p.x-start.x,0,1-r.width), y:clamp(r.y+p.y-start.y,0,1-r.height)};
      else {
        const anchor = mode === 'new' ? start : {x:mode.includes('w') ? r.x+r.width : r.x, y:mode.includes('n') ? r.y+r.height : r.y};
        const next = selectionFromPoints(anchor,p);
        if (next.width > .015 && next.height > .015) selection = next;
      }
      paint();
    };
    canvas.onpointerup = canvas.onpointercancel = () => { gesture = null; };
    canvas.onkeydown = event => {
      const movement = {ArrowLeft:[-.01,0],ArrowRight:[.01,0],ArrowUp:[0,-.01],ArrowDown:[0,.01]}[event.key];
      if (!movement) return;
      event.preventDefault();
      if (event.shiftKey) {
        selection.width = clamp(selection.width+movement[0],.02,1-selection.x);
        selection.height = clamp(selection.height+movement[1],.02,1-selection.y);
      } else {
        selection.x = clamp(selection.x+movement[0],0,1-selection.width);
        selection.y = clamp(selection.y+movement[1],0,1-selection.height);
      }
      paint();
    };
    dialog.querySelector('[data-rotate]').onclick = () => { turns = (turns + 1) % 4; drawImage(); };
    dialog.querySelector('[data-reset]').onclick = () => { selection = {x:0,y:0,width:1,height:1}; paint(); };
    dialog.querySelector('[data-close]').onclick = dialog.querySelector('[data-cancel]').onclick = () => finish(null);
    dialog.oncancel = event => { event.preventDefault(); finish(null); };
    dialog.onclose = () => finish(null);
    dialog.querySelector('[data-apply]').onclick = () => {
      try {
        const b = cropBounds(selection, base.width, base.height), output = document.createElement('canvas');
        const scale = Math.min(1, 1920 / Math.max(b.width, b.height));
        output.width = Math.max(1, Math.round(b.width*scale)); output.height = Math.max(1, Math.round(b.height*scale));
        output.getContext('2d').drawImage(base,b.x,b.y,b.width,b.height,0,0,output.width,output.height);
        const data = output.toDataURL('image/jpeg',.92);
        if (data.length > 5592430) throw new Error('裁剪后的图片仍然超过4MB，请缩小选区。');
        finish({image:data,width:output.width,height:output.height});
      } catch (error) {
        const box = dialog.querySelector('[data-error]'); box.textContent = error.message; box.hidden = false;
      }
    };
    dialog.showModal(); drawImage();
  });
}
