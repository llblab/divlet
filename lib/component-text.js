// Text-slot readback and sparse authoring patches; core supplies the parent shortcut, owns validation and expansion.
export function textOverride(instance, slot) {
  const overrides = instance.descendants || {};
  return overrides[slot.id]?.content ?? (slot.parentId ? overrides[slot.parentId]?.text : undefined);
}

export function textOverridePatch(instance, slot, content) {
  const overrides = instance.descendants || {}, patch = {};
  const remove = (address, field) => {
    const current = overrides[address];
    if (current?.[field] !== undefined) patch[address] = Object.keys(current).length === 1 ? null : { [field]: null };
  };
  if (slot.parentId) remove(slot.parentId, 'text');
  if (content === null) remove(slot.id, 'content');
  else patch[slot.id] = { content };
  return patch;
}
