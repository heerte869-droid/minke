// Membership is established by a share or an explicit tab creation, never by
// a Chrome group name. A user can put unrelated pages in the same visual group.
export async function groupNewTab(owner, tab, isCurrent) {
  if (!chrome.tabGroups || !isCurrent()) return;
  const member = owner.members.find(entry => entry.id === tab.id);
  if (!member) return;
  const title = owner.groupTitle || (owner.bili ? 'DSH · B 站' : 'DSH');
  let groupId;
  try {
    const fresh = await chrome.tabs.get(tab.id);
    if (fresh.windowId !== tab.windowId || fresh.pinned || fresh.groupId >= 0 || !isCurrent()) return;
    for (const entry of owner.members) {
      if (entry.groupId == null || entry.windowId !== tab.windowId) continue;
      const sibling = await chrome.tabs.get(entry.id).catch(() => null);
      if (sibling?.groupId !== entry.groupId || sibling.windowId !== tab.windowId) continue;
      const group = await chrome.tabGroups.get(entry.groupId).catch(() => null);
      if (group?.windowId === tab.windowId && !group.shared && group.title === title && group.color === 'purple') {
        if (!isCurrent()) return;
        groupId = await chrome.tabs.group({tabIds:[tab.id],groupId:group.id});
        break;
      }
    }
    if (groupId == null) {
      if (!isCurrent()) return;
      groupId = await chrome.tabs.group({tabIds:[tab.id],createProperties:{windowId:tab.windowId}});
      if (!isCurrent()) return;
      await chrome.tabGroups.update(groupId,{title,color:'purple'});
    }
    Object.assign(member,{groupId,windowId:tab.windowId,title});
  } finally {
    if (groupId != null && (!isCurrent() || member.groupId !== groupId)) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (current?.groupId === groupId) await chrome.tabs.ungroup(tab.id).catch(() => {});
    }
  }
}

export async function releaseGroups(members) {
  for (const entry of members) {
    if (entry.groupId == null) continue;
    try {
      const tab = await chrome.tabs.get(entry.id);
      if (tab.groupId !== entry.groupId || tab.windowId !== entry.windowId) continue;
      const group = await chrome.tabGroups.get(entry.groupId);
      if (group.shared || group.title !== entry.title || group.color !== 'purple') continue;
      await chrome.tabs.ungroup(entry.id);
    } catch { /* The user can move, ungroup or close a tab during release. */ }
  }
}
