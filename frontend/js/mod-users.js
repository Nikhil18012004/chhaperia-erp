/* ============================================================
   CHHAPERIA ERP — USERS & ACCESS (admin only)
   Create login accounts, reset passwords, assign roles + work
   areas, activate/deactivate. Talks to /api/auth/users via
   DB.users.*  (server enforces admin-only).
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, table, badge, toast, modal, confirm } = UI;
  const { pageHead } = MW;

  const ROLE_LABEL = { admin: "Administrator", office: "Office (Sales/Purchase/Finance)", supervisor: "Production Supervisor" };
  const ROLE_BADGE = { admin: "danger", office: "info", supervisor: "ok" };
  const AREA_LABEL = { coating: "Coating / Lamination", slitting: "Slitting + Pack/Dispatch", fiberglass: "Fibre-Glass + Slitting/Dispatch" };

  M.users = { title: "Users & Access", sub: "Logins & permissions", render(root) {
    root.appendChild(pageHead("Users & Access",
      "Create accounts, set roles & work areas, and reset passwords. Only admins see this page.",
      [ h("button", { class: "btn primary", onclick: () => userForm(), html: "＋ New User" }) ]));

    const wrap = h("div", { class: "card" }, [ h("div", { class: "muted", style: "padding:20px", text: "Loading users…" }) ]);
    root.appendChild(wrap);

    DB.users.list().then(({ users }) => {
      wrap.innerHTML = "";
      // group note
      wrap.appendChild(h("div", { class: "muted", style: "font-size:12px;margin-bottom:10px",
        html: "Default password for a new login is what you set. Share it with the person; they use it to sign in. You can reset it any time." }));

      wrap.appendChild(table(users, [
        { key: "name", label: "Name", render: r => `<div class="cell-main">${esc(r.name || r.username)}</div><div class="cell-sub">@${esc(r.username)}</div>` },
        { key: "role", label: "Role", render: r => badge(ROLE_BADGE[r.role] || "mut", ROLE_LABEL[r.role] || r.role) },
        { key: "area", label: "Work Area", render: r => r.area ? esc(AREA_LABEL[r.area] || r.area) : "<span class='muted'>—</span>" },
        { key: "active", label: "Status", render: r => r.active ? badge("ok", "Active") : badge("mut", "Disabled") },
        { key: "lastLogin", label: "Last Login", render: r => r.lastLogin ? esc(r.lastLogin.slice(0, 10)) : "<span class='muted'>never</span>" },
        { key: "act", label: "", noSort: true, render: r => "" , },
      ], { onRow: (r) => userActions(r) }));
    }).catch(err => {
      wrap.innerHTML = ""; wrap.appendChild(h("div", { class: "empty", style: "padding:30px" }, [
        h("div", { class: "big", text: "⚠" }), h("div", { text: "Could not load users: " + err.message }) ]));
    });
  }};

  /* ---- per-user actions (opens a small menu) ---- */
  function userActions(u) {
    const body = h("div", { class: "flex col gap" }, [
      h("div", { class: "flex between aic", style: "margin-bottom:6px" }, [
        h("div", {}, [ h("div", { style: "font-weight:700", text: u.name || u.username }),
          h("div", { class: "muted", text: "@" + u.username + " · " + (ROLE_LABEL[u.role] || u.role) + (u.area ? " · " + (AREA_LABEL[u.area] || u.area) : "") }) ]),
        badge(u.active ? "ok" : "mut", u.active ? "Active" : "Disabled"),
      ]),
      h("div", { class: "flex wrap gap" }, [
        h("button", { class: "btn sm", onclick: () => { mo.close(); userForm(u); }, html: "✎ Edit" }),
        h("button", { class: "btn sm", onclick: () => { mo.close(); resetPw(u); }, html: "🔑 Reset Password" }),
        h("button", { class: "btn sm", onclick: () => { mo.close(); toggleActive(u); }, html: u.active ? "⏸ Disable" : "▶ Enable" }),
        (u.id !== "U-ADMIN")
          ? h("button", { class: "btn sm", style: "color:var(--danger)", onclick: () => { mo.close(); removeUser(u); }, html: "🗑 Delete" })
          : null,
      ].filter(Boolean)),
    ]);
    const mo = modal({ title: "Manage: " + (u.name || u.username), body });
  }

  /* ---- create / edit ---- */
  function userForm(existing) {
    const edit = !!existing;
    const u = existing || { role: "supervisor", area: "coating", active: true };
    const f = (k, d) => (u[k] != null ? u[k] : d);

    const roleSel = `<select class="select" id="u_role">` +
      ["admin", "office", "supervisor"].map(r => `<option value="${r}" ${f("role") === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("") + `</select>`;
    const areaSel = `<select class="select" id="u_area">` +
      ["coating", "slitting", "fiberglass"].map(a => `<option value="${a}" ${f("area", "coating") === a ? "selected" : ""}>${AREA_LABEL[a]}</option>`).join("") + `</select>`;

    const body = h("div", { class: "form-grid" }, [
      field("Full Name", `<input class="input" id="u_name" value="${esc(f("name", ""))}" placeholder="e.g. Ramesh Kumar">`),
      field("Username (for login)", edit
        ? `<input class="input" value="${esc(u.username)}" disabled>`
        : `<input class="input" id="u_username" placeholder="e.g. coating3" autocomplete="off">`),
      field("Role", roleSel),
      field("Work Area (supervisors only)", areaSel, "area-wrap"),
      edit ? null : field("Password", `<input class="input" id="u_pass" type="text" placeholder="set an initial password (min 4 chars)">`, "full"),
    ].filter(Boolean));

    const mo = modal({ title: edit ? "Edit User" : "New User", sub: edit ? u.username : "Create a login account", body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: save, text: edit ? "Save Changes" : "Create User" }),
      ] });

    // toggle area visibility by role
    function syncArea() {
      const r = UI.$("#u_role").value;
      const aw = document.querySelector(".field.area-wrap");
      if (aw) aw.style.display = (r === "supervisor") ? "" : "none";
    }
    const roleEl = UI.$("#u_role");
    if (roleEl) roleEl.onchange = syncArea;
    syncArea();

    async function save() {
      const name = UI.$("#u_name").value.trim();
      const role = UI.$("#u_role").value;
      const area = role === "supervisor" ? UI.$("#u_area").value : null;
      try {
        if (edit) {
          await DB.users.update(u.id, { name, role, area });
          toast("User updated", { type: "ok" });
        } else {
          const username = UI.$("#u_username").value.trim();
          const password = UI.$("#u_pass").value;
          if (!username) { toast("Username is required", { type: "warn" }); return; }
          if (!password || password.length < 4) { toast("Password must be at least 4 characters", { type: "warn" }); return; }
          await DB.users.create({ username, name, role, area, password });
          toast("User created — share the password with them", { type: "ok" });
        }
        mo.close();
        App.go("users");
      } catch (e) { toast(e.message, { type: "danger" }); }
    }
  }

  /* ---- reset password ---- */
  function resetPw(u) {
    const body = h("div", { class: "form-grid" }, [
      field("New Password", `<input class="input" id="rp_pass" type="text" placeholder="min 4 characters">`, "full"),
      h("div", { class: "muted", style: "font-size:12px", text: "The user will sign in with this new password. Old one stops working immediately." }),
    ]);
    const mo = modal({ title: "Reset Password", sub: u.name || u.username, body,
      foot: [
        h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
        h("button", { class: "btn primary", onclick: save, text: "Set Password" }),
      ] });
    async function save() {
      const pass = UI.$("#rp_pass").value;
      if (!pass || pass.length < 4) { toast("Password must be at least 4 characters", { type: "warn" }); return; }
      try { await DB.users.update(u.id, { password: pass }); mo.close(); toast("Password reset for " + u.username, { type: "ok" }); }
      catch (e) { toast(e.message, { type: "danger" }); }
    }
  }

  async function toggleActive(u) {
    try { await DB.users.update(u.id, { active: !u.active }); toast(u.username + (u.active ? " disabled" : " enabled"), { type: "ok" }); App.go("users"); }
    catch (e) { toast(e.message, { type: "danger" }); }
  }

  async function removeUser(u) {
    if (!await confirm("Delete the login for " + (u.name || u.username) + "? This cannot be undone.", { title: "Delete User", danger: true })) return;
    try { await DB.users.remove(u.id); toast("User deleted", { type: "ok" }); App.go("users"); }
    catch (e) { toast(e.message, { type: "danger" }); }
  }

  function field(label, inner, cls) {
    return h("div", { class: "field" + (cls ? " " + cls : "") }, [h("label", { text: label }), h("div", { html: inner })]);
  }
})();
