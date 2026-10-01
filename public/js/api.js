async function request(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob) {
      init.body = body;
      init.headers['Content-Type'] = body.type;
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

export const api = {
  listProjects: () => request('GET', '/api/projects'),
  getProject: (id) => request('GET', `/api/projects/${id}`),
  createProject: (project) => request('POST', '/api/projects', project),
  updateProject: (id, project) => request('PUT', `/api/projects/${id}`, project),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),
  uploadBackground: (id, blob) => request('PUT', `/api/projects/${id}/background`, blob),
  deleteBackground: (id) => request('DELETE', `/api/projects/${id}/background`),
  backgroundUrl: (project) => `/api/projects/${project.id}/background?v=${project.background?.version ?? 0}`,
  readWifi: () => request('GET', '/api/wifi'),
};
