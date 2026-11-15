import sharp from "sharp";
const [src, out, x0, y0, w, h, scale] = process.argv.slice(2);
const X=+x0,Y=+y0,W=+w,H=+h,K=+scale;
let lines = "";
for (let x = Math.ceil(X/10)*10; x < X+W; x += 10) lines += `<line x1="${(x-X)*K}" y1="0" x2="${(x-X)*K}" y2="${H*K}" stroke="${x%50===0?'#f00':'#ff0'}" stroke-opacity="${x%50===0?.8:.3}" stroke-width="1"/>${x%50===0?`<text x="${(x-X)*K+2}" y="12" fill="#f00" font-size="12">${x}</text>`:''}`;
for (let y = Math.ceil(Y/10)*10; y < Y+H; y += 10) lines += `<line x1="0" y1="${(y-Y)*K}" x2="${W*K}" y2="${(y-Y)*K}" stroke="${y%50===0?'#f00':'#ff0'}" stroke-opacity="${y%50===0?.8:.3}" stroke-width="1"/>${y%50===0?`<text x="2" y="${(y-Y)*K-2}" fill="#f00" font-size="12">${y}</text>`:''}`;
const base = await sharp(src).extract({left:X,top:Y,width:W,height:H}).resize(W*K,H*K).toBuffer();
await sharp(base).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W*K}" height="${H*K}">${lines}</svg>`)}]).png().toFile(out);
