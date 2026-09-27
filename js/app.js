// S.in.P. — app logic
// Screens: loading -> login -> otp -> profile-setup -> partner -> intake-intro
//          -> intake -> waiting-reveal -> home

(function () {
  "use strict";

  const { createClient } = window.supabase;
  const sb = createClient(window.SINP_CONFIG.supabaseUrl, window.SINP_CONFIG.supabaseAnonKey);

  const screens = {};
  document.querySelectorAll("[data-screen]").forEach((el) => {
    screens[el.id] = el;
  });

  function showScreen(id) {
    Object.values(screens).forEach((el) => (el.hidden = true));
    if (screens[id]) screens[id].hidden = false;
    window.scrollTo(0, 0);
  }

  function showError(elId, message) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }
  function hideError(elId) {
    const el = document.getElementById(elId);
    if (el) el.hidden = true;
  }

  let pendingEmail = null;
  let currentUser = null;
  let currentProfile = null;
  let currentPartnership = null;
  let intakeStepIndex = 0;
  const INTAKE_STEP_COUNT = 9;

  // ---------------------------------------------------------------
  // Boot: check existing session
  // ---------------------------------------------------------------
  async function boot() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) {
      currentUser = data.session.user;
      await afterLogin();
    } else {
      showScreen("screen-login");
    }
  }

  sb.auth.onAuthStateChange((_event, session) => {
    if (session && session.user) {
      currentUser = session.user;
    }
  });

  // ---------------------------------------------------------------
  // Login: send OTP code
  // ---------------------------------------------------------------
  document.getElementById("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("login-error");
    const email = document.getElementById("input-email").value.trim();
    if (!email) return;

    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
      pendingEmail = email;
      document.getElementById("otp-target-email").textContent = `We stuurden een code naar ${email}`;
      showScreen("screen-otp");
    } catch (err) {
      showError("login-error", err.message || "Kon geen code versturen. Probeer het opnieuw.");
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById("btn-back-to-login").addEventListener("click", () => {
    hideError("otp-error");
    showScreen("screen-login");
  });

  // ---------------------------------------------------------------
  // OTP verification
  // ---------------------------------------------------------------
  document.getElementById("form-otp").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("otp-error");
    const token = document.getElementById("input-otp").value.trim();
    if (!pendingEmail || !token) return;

    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const { data, error } = await sb.auth.verifyOtp({
        email: pendingEmail,
        token,
        type: "email",
      });
      if (error) throw error;
      currentUser = data.user;
      await afterLogin();
    } catch (err) {
      showError("otp-error", err.message || "Code klopt niet, of is verlopen.");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------
  // After login: figure out where the user should land
  // ---------------------------------------------------------------
  async function afterLogin() {
    showScreen("screen-loading");

    // 1. Ensure profile exists
    const { data: profile, error: profileErr } = await sb
      .from("profiles")
      .select("*")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (profileErr) {
      console.error(profileErr);
    }

    if (!profile) {
      showScreen("screen-profile-setup");
      return;
    }
    currentProfile = profile;

    // 2. Check partnership
    const { data: partnerships } = await sb
      .from("partnerships")
      .select("*")
      .or(`created_by.eq.${currentUser.id},partner_id.eq.${currentUser.id}`)
      .order("created_at", { ascending: false });

    const active = (partnerships || []).find((p) => p.status === "active");
    const pending = (partnerships || []).find((p) => p.status === "pending");

    if (!active) {
      currentPartnership = pending || null;
      showScreen("screen-partner");
      if (pending && pending.created_by === currentUser.id) {
        document.getElementById("invite-code-box").hidden = false;
        document.getElementById("invite-code-value").textContent = pending.invite_code;
        document.getElementById("invite-waiting-hint").hidden = false;
      }
      return;
    }
    currentPartnership = active;

    // 3. Check intake status
    await routeAfterPartnership();
  }

  // ---------------------------------------------------------------
  // Profile setup
  // ---------------------------------------------------------------
  document.getElementById("form-profile").addEventListener("submit", async (e) => {
    e.preventDefault();
    const displayName = document.getElementById("input-display-name").value.trim();
    if (!displayName) return;

    const { data, error } = await sb
      .from("profiles")
      .insert({ id: currentUser.id, display_name: displayName })
      .select()
      .single();

    if (error) {
      alert("Kon profiel niet aanmaken: " + error.message);
      return;
    }
    currentProfile = data;
    showScreen("screen-partner");
  });

  // ---------------------------------------------------------------
  // Partner linking: tabs
  // ---------------------------------------------------------------
  document.querySelectorAll(".tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      tabBtn.classList.add("active");
      tabBtn.setAttribute("aria-selected", "true");
      const target = tabBtn.dataset.tab;
      document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== target;
      });
    });
  });

  document.getElementById("btn-create-invite").addEventListener("click", async () => {
    hideError("partner-error");
    try {
      const { data, error } = await sb
        .from("partnerships")
        .insert({ created_by: currentUser.id })
        .select()
        .single();
      if (error) throw error;
      currentPartnership = data;
      document.getElementById("invite-code-box").hidden = false;
      document.getElementById("invite-code-value").textContent = data.invite_code;
      document.getElementById("invite-waiting-hint").hidden = false;
      pollForPartnerJoin(data.id);
    } catch (err) {
      showError("partner-error", err.message);
    }
  });

  document.getElementById("btn-copy-invite").addEventListener("click", () => {
    const code = document.getElementById("invite-code-value").textContent;
    navigator.clipboard?.writeText(code).catch(() => {});
  });

  document.getElementById("form-join-invite").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("partner-error");
    const code = document.getElementById("input-invite-code").value.trim();
    if (!code) return;

    try {
      const { data: found, error: findErr } = await sb
        .from("partnerships")
        .select("*")
        .eq("invite_code", code)
        .eq("status", "pending")
        .maybeSingle();
      if (findErr) throw findErr;
      if (!found) throw new Error("Deze code is niet gevonden of al gebruikt.");
      if (found.created_by === currentUser.id) throw new Error("Je kunt niet je eigen code gebruiken.");

      const { data: updated, error: updateErr } = await sb
        .from("partnerships")
        .update({ partner_id: currentUser.id, status: "active" })
        .eq("id", found.id)
        .select()
        .single();
      if (updateErr) throw updateErr;

      currentPartnership = updated;
      await routeAfterPartnership();
    } catch (err) {
      showError("partner-error", err.message);
    }
  });

  let partnerPollTimer = null;
  function pollForPartnerJoin(partnershipId) {
    if (partnerPollTimer) clearInterval(partnerPollTimer);
    partnerPollTimer = setInterval(async () => {
      const { data } = await sb
        .from("partnerships")
        .select("*")
        .eq("id", partnershipId)
        .maybeSingle();
      if (data && data.status === "active") {
        clearInterval(partnerPollTimer);
        currentPartnership = data;
        await routeAfterPartnership();
      }
    }, 4000);
  }

  // ---------------------------------------------------------------
  // Route after we know the partnership: intake or home
  // ---------------------------------------------------------------
  async function routeAfterPartnership() {
    showScreen("screen-loading");

    const { data: myIntake } = await sb
      .from("intake_responses")
      .select("*")
      .eq("partnership_id", currentPartnership.id)
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (!myIntake || !myIntake.submitted_at) {
      showScreen("screen-intake-intro");
      const hint = document.getElementById("intake-status-hint");
      hint.textContent = myIntake ? "Je hebt een concept opgeslagen — ga verder waar je was gebleven." : "";
      return;
    }

    goHome();
  }

  // ---------------------------------------------------------------
  // Intake wizard
  // ---------------------------------------------------------------
  document.getElementById("btn-start-intake").addEventListener("click", () => {
    intakeStepIndex = 0;
    renderIntakeStep();
    showScreen("screen-intake");
  });

  function renderIntakeStep() {
    document.querySelectorAll(".intake-step").forEach((stepEl) => {
      stepEl.classList.toggle("active", Number(stepEl.dataset.step) === intakeStepIndex + 1);
    });
    const progress = Math.round(((intakeStepIndex + 1) / INTAKE_STEP_COUNT) * 100);
    document.getElementById("intake-progress").style.width = progress + "%";

    document.getElementById("btn-intake-prev").hidden = intakeStepIndex === 0;
    const isLast = intakeStepIndex === INTAKE_STEP_COUNT - 1;
    document.getElementById("btn-intake-next").hidden = isLast;
    document.getElementById("btn-intake-submit").hidden = !isLast;
  }

  document.getElementById("btn-intake-prev").addEventListener("click", () => {
    if (intakeStepIndex > 0) {
      intakeStepIndex--;
      renderIntakeStep();
    }
  });
  document.getElementById("btn-intake-next").addEventListener("click", () => {
    if (intakeStepIndex < INTAKE_STEP_COUNT - 1) {
      intakeStepIndex++;
      renderIntakeStep();
    }
  });

  function collectIntakeFormData() {
    const form = document.getElementById("form-intake");
    const payload = {
      personal_goals: form.personal_goals.value.trim() || null,
      relationship_goals: form.relationship_goals.value.trim() || null,
      energy_and_duration: form.energy_and_duration.value.trim() || null,
      boundaries: form.boundaries.value.trim() || null,
      things_to_avoid: form.things_to_avoid.value.trim() || null,
      preferred_frequency: form.querySelector('input[name="preferred_frequency"]:checked')?.value || null,
      preferred_time_of_day: form.querySelector('input[name="preferred_time_of_day"]:checked')?.value || null,
      interaction_style: form.querySelector('input[name="interaction_style"]:checked')?.value || null,
      preferred_activities: Array.from(
        document.querySelectorAll('[data-name="preferred_activities"] input:checked')
      ).map((el) => el.value),
    };
    return payload;
  }

  document.getElementById("form-intake").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("intake-error");
    const payload = collectIntakeFormData();
    payload.partnership_id = currentPartnership.id;
    payload.user_id = currentUser.id;
    payload.submitted_at = new Date().toISOString();

    try {
      const { error } = await sb
        .from("intake_responses")
        .upsert(payload, { onConflict: "partnership_id,user_id" });
      if (error) throw error;
      showScreen("screen-waiting-reveal");
    } catch (err) {
      showError("intake-error", err.message);
    }
  });

  document.getElementById("btn-refresh-reveal").addEventListener("click", async () => {
    await routeAfterPartnership();
  });

  // ---------------------------------------------------------------
  // Home / dashboard
  // ---------------------------------------------------------------
  async function goHome() {
    document.getElementById("home-greeting").textContent = `Hoi ${currentProfile?.display_name || ""}!`;
    await loadTomorrowChoice();
    showScreen("screen-home");
  }

  document.getElementById("form-checkin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      user_id: currentUser.id,
      checkin_date: new Date().toISOString().slice(0, 10),
      mood: Number(form.mood.value),
      energy: Number(form.energy.value),
      capacity: Number(form.capacity.value),
      reflection: form.reflection.value.trim() || null,
    };
    const statusEl = document.getElementById("checkin-status");
    try {
      const { error } = await sb
        .from("daily_checkins")
        .upsert(payload, { onConflict: "user_id,checkin_date" });
      if (error) throw error;
      statusEl.textContent = "Opgeslagen ✅";
    } catch (err) {
      statusEl.textContent = "Kon niet opslaan: " + err.message;
    }
  });

  async function loadTomorrowChoice() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const { data } = await sb
      .from("tomorrow_choices")
      .select("*")
      .eq("partnership_id", currentPartnership.id)
      .eq("choice_date", tomorrowStr)
      .maybeSingle();

    const textEl = document.getElementById("tomorrow-choice-text");
    if (data) {
      textEl.textContent = `Voorstel: ${data.activity_text} (${data.duration_minutes} min) — status: ${data.status}`;
    } else {
      textEl.textContent = "Nog geen voorstel voor morgen.";
    }
  }

  document.getElementById("form-tomorrow").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const activityText = form.activity_text.value.trim();
    if (!activityText) return;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const payload = {
      partnership_id: currentPartnership.id,
      proposed_by: currentUser.id,
      choice_date: tomorrowStr,
      activity_text: activityText,
      duration_minutes: Number(form.duration_minutes.value),
    };

    try {
      const { error } = await sb
        .from("tomorrow_choices")
        .upsert(payload, { onConflict: "partnership_id,choice_date" });
      if (error) throw error;
      form.reset();
      await loadTomorrowChoice();
    } catch (err) {
      alert("Kon voorstel niet opslaan: " + err.message);
    }
  });

  document.getElementById("form-beaver-week").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const reason = form.reason.value.trim();
    if (!reason) return;

    const partnerUserId =
      currentPartnership.created_by === currentUser.id
        ? currentPartnership.partner_id
        : currentPartnership.created_by;

    if (!partnerUserId) {
      alert("Partner nog niet gekoppeld.");
      return;
    }

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    const weekStartStr = weekStart.toISOString().slice(0, 10);

    try {
      const { error } = await sb.from("beaver_of_the_week").upsert(
        {
          partnership_id: currentPartnership.id,
          nominated_by: currentUser.id,
          nominated_user_id: partnerUserId,
          week_start: weekStartStr,
          reason,
        },
        { onConflict: "partnership_id,week_start,nominated_user_id" }
      );
      if (error) throw error;
      form.reset();
      alert("Nominatie opgeslagen!");
    } catch (err) {
      alert("Kon nominatie niet opslaan: " + err.message);
    }
  });

  document.getElementById("btn-logout").addEventListener("click", async () => {
    await sb.auth.signOut();
    currentUser = null;
    currentProfile = null;
    currentPartnership = null;
    showScreen("screen-login");
  });

  boot();
})();
