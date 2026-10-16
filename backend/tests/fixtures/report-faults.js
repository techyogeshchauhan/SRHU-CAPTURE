const http = require('http');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADwAAAAoCAIAAAAt2Q6oAAAAR0lEQVR4nO3OQQ0AIRAAsQXlJ/088CghmSromvnmNft24ERppbRSWimtlFZKK6WV0kpppbRSWimtlFZKK6WV0kpppbRSWvkBqxYA0Mj83lkAAAAASUVORK5CYII=', 'base64');
http.createServer((req, res) => {
 res.setHeader('Access-Control-Allow-Origin', '*');
 res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
 res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
 if(req.method === 'OPTIONS') {res.writeHead(204); return res.end();}
 const path = new URL(req.url,'http://local.test').pathname;
 if(path.includes('/fixture/r2-')) {res.writeHead(200,{'Content-Type':'image/png','Content-Length':image.length}); return res.end(image);}
 if(path.includes('/fixture/large-')) {
   // A valid image with padding models a 14 MB camera original over a
   // healthy connection taking longer than the former 20-second deadline.
   const body=Buffer.concat([image,Buffer.alloc(14*1024*1024-image.length)]);
   res.writeHead(200,{'Content-Type':'image/png','Content-Length':body.length});
   let offset=0;
   const send=()=>{const end=Math.min(offset+256*1024,body.length);res.write(body.subarray(offset,end));offset=end;if(offset===body.length){clearInterval(interval);res.end();}};
   const interval=setInterval(send,500);
   res.on('close',()=>clearInterval(interval)); return;
 }
 if(path.includes('/fixture/hung-') || path.endsWith('/body-hang')) {
   res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':1000000}); res.write('%PDF-1.4\n'); return;
 }
 if(path.includes('/fixture/drip-')) {
   res.writeHead(200,{'Content-Type':'image/png'});
   const interval=setInterval(()=>res.write('x'),100);
   res.on('close',()=>clearInterval(interval)); return;
 }
 if(path.endsWith('/headers-hang')) return;
 if(path.endsWith('/proxy-error')) {res.writeHead(502,{'Content-Type':'text/html'}); return res.end('<html>Upstream unavailable</html>');}
 if(path.endsWith('/invalid')) {res.writeHead(200,{'Content-Type':'text/html'}); return res.end('<html>Not a PDF</html>');}
 res.writeHead(501,{'Content-Type':'application/json'}); res.end(JSON.stringify({detail:'Endpoint not modeled by report fault simulation'}));
}).listen(process.env.PORT);
