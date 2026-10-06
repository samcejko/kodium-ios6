// Patches object-fit-images 3.2.4 (downloaded by the build) for the iOS 6 engine; fails when the text changed.
//   node tools/patch-ofi.js Resources/js/object-fit-images.js
var fs = require('fs');
var file = process.argv[2];
var s = fs.readFileSync(file, 'utf8');

function replace(from, to) {
    if (s.indexOf(from) < 0) {
        console.error('patch-ofi: not found: ' + from);
        process.exit(1);
    }
    s = s.split(from).join(to);
}

// Its wait for a picture's size polled every 100 ms forever when the picture had no address yet (lazy pictures:
// dozens of endless timers on YouTube) or could not be loaded; the shim gives the copy its address when the picture
// loads (the attribute: an empty src property reads as the page's own address).
replace('setTimeout(n,100,t,e)', 't.getAttribute("src")&&!t.complete&&setTimeout(n,100,t,e)');
// A picture without an address yet (src="", lazy loading: YouTube's thumbnails) is left alone until it gets one (its
// load event brings it back): its src property reads as the page's own address, so the copy and the background
// asked for the page itself as a picture - YouTube's whole 700 KB page was fetched and rewritten every few seconds.
replace('if(!o.img){o.img=new Image(t.width,t.height)',
        'if(!o.img){var a0=b.call(t,"src");if(!b.call(t,"data-ofi-src")&&!b.call(t,"data-ofi-srcset")&&!(a0&&/\\S/.test(a0))&&!t.srcset)return;o.img=new Image(W!=null?W:t.width,H!=null?H:t.height)');
// Reading a computed style or a size lays the page out again when anything changed since, and the library read one
// picture's style right after changing the previous picture: a layout per picture (seznam.cz: 10-16 s at
// DOMContentLoaded and again after every settle). All styles and sizes are read first, then the pictures are changed;
// pictures that load are taken in batches.
replace('function c(t){var c=i(t),o=t[l];', 'function c(t){var o=t[l],c=o.st||i(t),W=o.w,H=o.h;o.st=o.w=o.h=null;');
replace('r(t,t.naturalWidth||t.width,t.naturalHeight||t.height)', 'r(t,t.naturalWidth||(W!=null?W:t.width),t.naturalHeight||(H!=null?H:t.height))');
// (GS: the style reader, whose name i is taken by a variable inside fix)
// (window.__brOfiPrep, shims-extra.js: what the shim's placeholder needs to know of the pictures to change, read for
// all of them at once)
replace('for(var r=0;r<t.length;r++)t[r][l]=t[r][l]||{skipTest:e.skipTest},c(t[r]);',
        'for(var r=0;r<t.length;r++){var q0=t[r][l]=t[r][l]||{skipTest:e.skipTest};q0.st=GS(t[r]);q0.w=t[r].width;q0.h=t[r].height}' +
        'if(window.__brOfiPrep){var P0=[];for(r=0;r<t.length;r++){var s0=t[r][l].st;s0&&s0["object-fit"]&&"fill"!==s0["object-fit"]&&P0.push(t[r])}P0.length&&window.__brOfiPrep(P0)}' +
        'for(r=0;r<t.length;r++)c(t[r]);');
replace('"IMG"===t.target.tagName&&a(t.target,{skipTest:e.skipTest})',
        '"IMG"===t.target.tagName&&(Q.push(t.target),QT||(QT=setTimeout(function(){var z=Q;Q=[];QT=0;a(z,{skipTest:e.skipTest})},120)))');
replace('var l="bfred-it:object-fit-images",', 'var Q=[],QT=0,GS=i,l="bfred-it:object-fit-images",');
// The placeholder comes from the shim (window.__brOfiPH in shims-extra.js): the library's SVG placeholder made
// WebKit skip the element's background, which carries the picture.
replace('var n=t(i||1,r||0)', 'var n=window.__brOfiPH?window.__brOfiPH(e,i||1,r||0):t(i||1,r||0)');

fs.writeFileSync(file, s);
console.log('patch-ofi: ' + file + ' patched (' + s.length + ' bytes)');
