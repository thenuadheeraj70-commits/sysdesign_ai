import { useState } from "react";

export default function ComponentPanel({ component, onChange, onDelete, onClose }) {
  const [name, setName] = useState(component.name);
  const [type, setType] = useState(component.type);
  const [provider, setProvider] = useState(component.provider);
  function apply() {
    onChange({ name: name.trim() || component.name, type: type.trim() || component.type, provider: provider.trim() || component.provider });
  }
  return <aside className="panel-side">
    <div className="side-head"><strong>Edit component</strong><button type="button" onClick={onClose}>×</button></div>
    <label>Name<input value={name} onChange={e=>setName(e.target.value)} /></label>
    <label>Type<input value={type} onChange={e=>setType(e.target.value)} /></label>
    <label>Provider<input value={provider} onChange={e=>setProvider(e.target.value)} /></label>
    <p className="hint">ID: {component.id}</p>
    <div className="side-actions"><button type="button" onClick={apply}>Save</button><button type="button" className="danger" onClick={onDelete}>Delete</button></div>
  </aside>;
}
