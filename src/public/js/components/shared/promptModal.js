import { $ } from '../../utils/dom.js';

// ---------- Özel Modal Prompt (native prompt() yok) ----------
function showPromptModal({ title, desc = '', fields = [], okText = 'Onayla' }) {
  return new Promise((resolve) => {
    const dlg = $('prompt-dialog');
    $('prompt-title').textContent = title;
    $('prompt-desc').textContent = desc;
    $('btn-prompt-ok').textContent = okText;

    const container = $('prompt-fields');
    container.innerHTML = '';
    for (const f of fields) {
      const lbl = document.createElement('label');
      lbl.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = f.type || 'text';
      inp.name = f.name;
      inp.value = f.value ?? '';
      inp.placeholder = f.placeholder || '';
      container.appendChild(lbl);
      container.appendChild(inp);
    }

    let settled = false;
    const cleanup = (val) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(val);
    };

    $('btn-prompt-cancel').onclick = () => cleanup(null);
    $('prompt-form').onsubmit = (e) => {
      e.preventDefault();
      const result = {};
      for (const f of fields) {
        result[f.name] = container.querySelector(`[name="${f.name}"]`).value;
      }
      cleanup(result);
    };
    dlg.oncancel = () => cleanup(null);
    dlg.onclose = () => cleanup(null);
    dlg.showModal();
    const firstInp = container.querySelector('input');
    if (firstInp) {
      firstInp.focus();
      firstInp.select();
    }
  });
}


export {
  showPromptModal,
};
