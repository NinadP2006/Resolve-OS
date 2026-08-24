const BASE_URL = import.meta.env.VITE_API_URL || '/api';

export async function fetchTickets() {
  const res = await fetch(`${BASE_URL}/tickets`);
  if (!res.ok) throw new Error('Failed to fetch tickets');
  return res.json();
}

export async function fetchTicketDetails(id) {
  const res = await fetch(`${BASE_URL}/tickets/${id}`);
  if (!res.ok) throw new Error('Failed to fetch ticket details');
  return res.json();
}

export async function fetchMetrics() {
  const res = await fetch(`${BASE_URL}/metrics`);
  if (!res.ok) throw new Error('Failed to fetch metrics');
  return res.json();
}

export async function createTicket(ticketData) {
  const res = await fetch(`${BASE_URL}/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ticketData)
  });
  if (!res.ok) throw new Error('Failed to create ticket');
  return res.json();
}

export async function triggerRun(id) {
  const res = await fetch(`${BASE_URL}/tickets/${id}/run`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error('Failed to trigger run');
  return res.json();
}

export async function approveTicket(id, actor) {
  const res = await fetch(`${BASE_URL}/tickets/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to approve');
  }
  return res.json();
}

export async function rejectTicket(id, actor, reason) {
  const res = await fetch(`${BASE_URL}/tickets/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, reason })
  });
  if (!res.ok) throw new Error('Failed to reject');
  return res.json();
}

export async function requestChanges(id, actor, comments) {
  const res = await fetch(`${BASE_URL}/tickets/${id}/request-changes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, comments })
  });
  if (!res.ok) throw new Error('Failed to request changes');
  return res.json();
}
