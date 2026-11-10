// Stand-in for the worker URL that Vite produces in a real build: in Node, pdf.js runs its worker on the
// main thread and loads it by import, so this is the address of the legacy worker file.
export default new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
