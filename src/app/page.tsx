"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Prompt = {
  id: string;
  text: string;
  pack: string;
};

type Hunt = {
  id: string;
  code: string;
  pack: string | null;
  completion_mode: "anytime" | "all_required" | null;
  required_prompt_count: number | null;
  status: "lobby" | "active" | "voting" | "finished";
};

type SubmissionStatus =
  | "idle"
  | "saving"
  | "needs_photo"
  | "uploading"
  | "saved"
  | "error";

type HuntPlayer = {
  id: string;
  player_id: string;
  display_name: string | null;
  finished_at: string | null;
  role: string | null;
};

type PlayerGame = {
  hunt_id: string;
  hunt_code: string;
  hunt_status: "lobby" | "active" | "voting" | "finished";
  pack: string | null;
  joined_at: string;
  finished_at: string | null;
  role: string | null;
};

type Pack = {
  slug: string;
  name: string;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_km: number | null;
  area: string | null;
};

type Submission = {
  id: string;
  prompt_id: string;
  player_id: string;
  photo_path: string;
  display_name: string;
};

function getFileExt(name: string) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "jpg";
}

function makeId() {
  try {
    // @ts-ignore
    return crypto?.randomUUID?.() ?? String(Date.now());
  } catch {
    return String(Date.now());
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Storage can be slightly "eventually consistent" right after upload.
 * This retries signed URL generation a few times.
 */
async function getSignedUrlWithRetry(
  path: string,
  tries = 6,
  delayMs = 400
): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const { data, error } = await supabase.storage
      .from("photos")
      .createSignedUrl(path, 60 * 60); // 1 hour

    if (!error && data?.signedUrl) return data.signedUrl;
    await sleep(delayMs);
  }
  return null;
}

function generateCode(len = 5) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function packLabel(pack: string) {
  // MVP label: slug -> nicer text
  return pack
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function Home() {
  const [error, setError] = useState<string | null>(null);

  // Player identity (device-local)
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState<string>("");

  // Hunt selection
  const [huntId, setHuntId] = useState<string | null>(null);
  const [hunt, setHunt] = useState<Hunt | null>(null);

  // Create/Join UI
  const [availablePacks, setAvailablePacks] = useState<Pack[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [createPack, setCreatePack] = useState<string>("");
  const [createCompletionMode, setCreateCompletionMode] = useState<"anytime" | "all_required">(
    "anytime"
  );
  const [createRequiredCount, setCreateRequiredCount] = useState<string>("");

  // Prompts + submissions state
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [statusByPromptId, setStatusByPromptId] = useState<Record<string, SubmissionStatus>>({});
  const [submissionIdByPromptId, setSubmissionIdByPromptId] = useState<Record<string, string>>({});
  const [photoPathByPromptId, setPhotoPathByPromptId] = useState<Record<string, string>>({});
  const [photoUrlByPromptId, setPhotoUrlByPromptId] = useState<Record<string, string>>({});

  // Finish state
  const [finishedAt, setFinishedAt] = useState<string | null>(null);

  // Hunt players (for showing who's in the hunt)
  const [huntPlayers, setHuntPlayers] = useState<HuntPlayer[]>([]);

  // Host status (for controlling game start)
  const [isHost, setIsHost] = useState(false);

  // Player's game history
  const [playerGames, setPlayerGames] = useState<PlayerGame[]>([]);

  // Name editing in lobby
  const [isEditingName, setIsEditingName] = useState(false);
  const [editingNameValue, setEditingNameValue] = useState("");

  // Voting state
  const [allSubmissions, setAllSubmissions] = useState<Submission[]>([]);
  const [currentPromptIndex, setCurrentPromptIndex] = useState(0);
  const [votedPromptIds, setVotedPromptIds] = useState<Set<string>>(new Set());
  const [submissionUrls, setSubmissionUrls] = useState<Record<string, string>>({});

  // Results state
  const [results, setResults] = useState<{
    promptWinners: Array<{
      prompt: Prompt;
      winner: { display_name: string; votes: number; photo_url: string } | null;
    }>;
    leaderboard: Array<{ display_name: string; total_votes: number }>;
  } | null>(null);

  // upload flow
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Helper to get pack name from slug, with fallback to formatted slug
  function getPackName(slug: string | null): string {
    if (!slug) return "Unknown Pack";
    const pack = availablePacks.find((p) => p.slug === slug);
    if (pack) return pack.name;
    // Fallback: format slug nicely
    return packLabel(slug);
  }

  // Helper to get pack description from slug
  function getPackDescription(slug: string | null): string | null {
    if (!slug) return null;
    const pack = availablePacks.find((p) => p.slug === slug);
    return pack?.description ?? null;
  }

  // Helper to get pack location info (area and distance)
  function getPackLocationInfo(slug: string | null): { area: string | null; distance: number | null } | null {
    if (!slug) return null;
    const pack = availablePacks.find((p) => p.slug === slug);
    if (!pack) return null;
    if (!pack.area && !pack.radius_km) return null;
    return { area: pack.area, distance: pack.radius_km };
  }

  // Helper to save player name to localStorage
  function savePlayerName(name: string) {
    setPlayerName(name);
    localStorage.setItem("player_name", name);
  }

  // Update display name in hunt_players table
  async function updateDisplayName(newName: string) {
    if (!huntId || !playerId) return;

    const displayName = newName.trim() || "Anonymous";

    const { error } = await supabase
      .from("hunt_players")
      .update({ display_name: displayName })
      .eq("hunt_id", huntId)
      .eq("player_id", playerId);

    if (error) {
      console.error("Failed to update display name:", error);
      setError(error.message);
      return;
    }

    // Update local state
    savePlayerName(displayName);
    setHuntPlayers((prev) =>
      prev.map((p) =>
        p.player_id === playerId ? { ...p, display_name: displayName } : p
      )
    );
    setIsEditingName(false);
  }

  // --------------------------
  // Boot: load local storage
  // --------------------------
  useEffect(() => {
    const storedHuntId = localStorage.getItem("hunt_id");
    if (storedHuntId) setHuntId(storedHuntId);

    const storedPlayerId = localStorage.getItem("player_id");
    if (storedPlayerId) setPlayerId(storedPlayerId);

    const storedPlayerName = localStorage.getItem("player_name");
    if (storedPlayerName) setPlayerName(storedPlayerName);
  }, []);

  // --------------------------
  // Ensure player exists (FK-safe)
  // --------------------------
  useEffect(() => {
    if (playerId) return;

    (async () => {
      const { data, error } = await supabase
        .from("players")
        .insert({ name: "anon" })
        .select("id")
        .single();

      if (error) {
        console.error("Failed to create player:", error);
        setError(error.message);
        return;
      }

      localStorage.setItem("player_id", data.id);
      setPlayerId(data.id);
    })();
  }, [playerId]);

  // --------------------------
  // Load player's game history (only when on home screen)
  // --------------------------
  useEffect(() => {
    if (!playerId || huntId) return; // Only fetch when on home screen

    async function fetchPlayerGames() {
      const { data, error } = await supabase
        .from("hunt_players")
        .select(`
          hunt_id,
          joined_at,
          finished_at,
          role,
          hunts (
            code,
            status,
            pack
          )
        `)
        .eq("player_id", playerId)
        .order("joined_at", { ascending: false });

      if (error) {
        console.error("Failed to load player games:", error);
        return;
      }

      if (data) {
        const games = data.map((row: any) => ({
          hunt_id: row.hunt_id,
          hunt_code: row.hunts?.code ?? "???",
          hunt_status: row.hunts?.status ?? "finished",
          pack: row.hunts?.pack,
          joined_at: row.joined_at,
          finished_at: row.finished_at,
          role: row.role,
        }));
        setPlayerGames(games);
      }
    }

    fetchPlayerGames();
  }, [playerId, huntId]);

  // --------------------------
  // Load available packs from packs table
  // --------------------------
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("packs")
        .select("slug, name, description, latitude, longitude, radius_km, area")
        .order("name");

      if (error) {
        console.error("Failed to load packs:", error);
        setError(error.message);
        return;
      }

      setAvailablePacks(data ?? []);

      // default selection
      if (!createPack && data && data.length > 0) {
        setCreatePack(data[0].slug);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------
  // Load hunt metadata when huntId set
  // --------------------------
  useEffect(() => {
    if (!huntId) {
      setHunt(null);
      return;
    }

    (async () => {
      const { data, error } = await supabase
        .from("hunts")
        .select("id, code, pack, completion_mode, required_prompt_count, status")
        .eq("id", huntId)
        .single();

      if (error) {
        console.error("Failed to load hunt:", error);
        setError(error.message);
        return;
      }

      setHunt(data as Hunt);
    })();
  }, [huntId]);

  // --------------------------
  // Real-time subscription for hunt status changes
  // --------------------------
  useEffect(() => {
    if (!huntId) return;

    const channel = supabase
      .channel(`hunt-${huntId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "hunts",
          filter: `id=eq.${huntId}`,
        },
        (payload) => {
          // Update hunt state with new data
          setHunt((prev) => (prev ? { ...prev, ...payload.new } as Hunt : null));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [huntId]);

  // --------------------------
  // Ensure membership in hunt_players, and load finished_at
  // --------------------------
  useEffect(() => {
    if (!huntId || !playerId) return;

    (async () => {
      // Check if already joined (to avoid overwriting host role)
      const { data: existing } = await supabase
        .from("hunt_players")
        .select("id, finished_at, role")
        .eq("hunt_id", huntId)
        .eq("player_id", playerId)
        .single();

      if (!existing) {
        // Use upsert to handle race conditions (requires unique constraint on hunt_id, player_id)
        const { error: upsertError } = await supabase
          .from("hunt_players")
          .upsert(
            {
              hunt_id: huntId,
              player_id: playerId,
              display_name: playerName || "Anonymous",
              role: "player",
            },
            { onConflict: "hunt_id,player_id", ignoreDuplicates: true }
          );

        if (upsertError) {
          console.error("Failed to join hunt:", upsertError);
          setError(upsertError.message);
          return;
        }
      }

      // Always fetch fresh data to ensure we have the correct state
      const { data: playerData, error: fetchError } = await supabase
        .from("hunt_players")
        .select("finished_at, role")
        .eq("hunt_id", huntId)
        .eq("player_id", playerId)
        .single();

      if (fetchError) {
        console.error("Failed to load player data:", fetchError);
        return;
      }

      setFinishedAt(playerData?.finished_at ?? null);
      setIsHost(playerData?.role === "host");
    })();
  }, [huntId, playerId]);

  // --------------------------
  // Load all players in this hunt (with real-time updates)
  // --------------------------
  useEffect(() => {
    if (!huntId) {
      setHuntPlayers([]);
      return;
    }

    // Initial fetch
    async function fetchPlayers() {
      const { data, error } = await supabase
        .from("hunt_players")
        .select("id, player_id, display_name, finished_at, role")
        .eq("hunt_id", huntId);

      if (error) {
        console.error("Failed to load hunt players:", error);
        return;
      }

      setHuntPlayers((data ?? []) as HuntPlayer[]);
    }

    fetchPlayers();

    // Real-time subscription for player changes
    const channel = supabase
      .channel(`hunt-players-${huntId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "hunt_players",
          filter: `hunt_id=eq.${huntId}`,
        },
        () => {
          // Refetch all players on any change
          fetchPlayers();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [huntId]);

  // --------------------------
  // Load prompts for this hunt (via hunt.pack)
  // --------------------------
  useEffect(() => {
    if (!hunt?.pack) {
      setPrompts([]);
      return;
    }

    (async () => {
      const { data, error } = await supabase
        .from("prompts")
        .select("id, text, pack")
        .eq("pack", hunt.pack);

      if (error) {
        console.error("Failed to load prompts:", error);
        setError(error.message);
        return;
      }

      setPrompts((data ?? []) as Prompt[]);
    })();
  }, [hunt?.pack]);

  // --------------------------
  // Load submissions for this player + hunt (photo persistence)
  // --------------------------
  useEffect(() => {
    if (!huntId || !playerId) return;

    (async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("id, prompt_id, photo_path")
        .eq("hunt_id", huntId)
        .eq("player_id", playerId);

      if (error) {
        console.error("Failed to load existing submissions:", error);
        return;
      }

      const nextStatus: Record<string, SubmissionStatus> = {};
      const nextSubmissionIds: Record<string, string> = {};
      const nextPhotoPaths: Record<string, string> = {};
      const nextPhotoUrls: Record<string, string> = {};

      for (const row of data ?? []) {
        if (!row.prompt_id) continue;

        nextSubmissionIds[row.prompt_id] = row.id;

        if (row.photo_path) {
          nextPhotoPaths[row.prompt_id] = row.photo_path;
          nextStatus[row.prompt_id] = "saved";
        } else {
          nextStatus[row.prompt_id] = "needs_photo";
        }
      }

      setSubmissionIdByPromptId(nextSubmissionIds);
      setPhotoPathByPromptId(nextPhotoPaths);
      setStatusByPromptId(nextStatus);

      // signed URLs
      for (const [promptId, path] of Object.entries(nextPhotoPaths)) {
        const signedUrl = await getSignedUrlWithRetry(path);
        if (signedUrl) nextPhotoUrls[promptId] = signedUrl;
      }

      setPhotoUrlByPromptId((prev) => ({ ...prev, ...nextPhotoUrls }));
    })();
  }, [huntId, playerId]);

  // --------------------------
  // Create / Join actions
  // --------------------------
  async function joinHuntByCode() {
    setError(null);
    const code = joinCode.trim().toUpperCase();
    if (!code) return;

    const { data, error } = await supabase
      .from("hunts")
      .select("id")
      .eq("code", code)
      .single();

    if (error) {
      setError(error.message);
      return;
    }

    localStorage.setItem("hunt_id", data.id);
    setHuntId(data.id);
  }

  async function createHunt() {
    setError(null);

    const pack = createPack;
    if (!pack) {
      setError("Please select a pack.");
      return;
    }

    const completion_mode = createCompletionMode;
    const required_prompt_count =
      createRequiredCount.trim() === "" ? null : Number(createRequiredCount);

    const code = generateCode(5);

    // Create hunt (starts in lobby)
    const { data: huntRow, error: huntError } = await supabase
      .from("hunts")
      .insert({
        code,
        pack,
        completion_mode,
        required_prompt_count,
        // keep title deprecated but safe if column exists / non-null:
        title: `${pack} hunt`,
        status: "lobby",
      } as any)
      .select("id")
      .single();

    if (huntError) {
      setError(huntError.message);
      return;
    }

    const newHuntId = huntRow.id as string;

    // Seed hunt_prompts from prompts in this pack
    const { data: packPrompts, error: packErr } = await supabase
      .from("prompts")
      .select("id")
      .eq("pack", pack);

    if (packErr) {
      setError(packErr.message);
      return;
    }

    const rows = (packPrompts ?? []).map((p: any) => ({
      hunt_id: newHuntId,
      prompt_id: p.id,
    }));

    if (rows.length > 0) {
      const { error: seedErr } = await supabase.from("hunt_prompts").insert(rows);
      if (seedErr) {
        setError(seedErr.message);
        return;
      }
    }

    // Join as host
    const { error: hostErr } = await supabase
      .from("hunt_players")
      .upsert(
        {
          hunt_id: newHuntId,
          player_id: playerId,
          display_name: playerName || "Anonymous",
          role: "host",
        },
        { onConflict: "hunt_id,player_id" }
      );

    if (hostErr) {
      setError(hostErr.message);
      return;
    }

    setIsHost(true);
    localStorage.setItem("hunt_id", newHuntId);
    setHuntId(newHuntId);

    // show the code to copy (simple MVP: alert)
    alert(`Hunt created! Code: ${code}`);
  }

  function changeHunt() {
    localStorage.removeItem("hunt_id");
    setHuntId(null);
    setHunt(null);
    setPrompts([]);
    setStatusByPromptId({});
    setSubmissionIdByPromptId({});
    setPhotoPathByPromptId({});
    setPhotoUrlByPromptId({});
    setFinishedAt(null);
    setHuntPlayers([]);
    setIsHost(false);
  }

  // --------------------------
  // Game history actions
  // --------------------------
  function resumeGame(gameHuntId: string) {
    localStorage.setItem("hunt_id", gameHuntId);
    setHuntId(gameHuntId);
  }

  async function leaveGame(gameHuntId: string) {
    if (!playerId) return;

    const confirmed = window.confirm("Are you sure you want to leave this game?");
    if (!confirmed) return;

    const { error } = await supabase
      .from("hunt_players")
      .delete()
      .eq("hunt_id", gameHuntId)
      .eq("player_id", playerId);

    if (error) {
      setError(error.message);
      return;
    }

    // Remove from local state
    setPlayerGames((prev) => prev.filter((g) => g.hunt_id !== gameHuntId));
  }

  // --------------------------
  // Submissions + upload
  // --------------------------
  async function ensureSubmission(promptId: string) {
    const existing = submissionIdByPromptId[promptId];
    if (existing) return existing;

    if (!huntId || !playerId) throw new Error("Missing huntId/playerId");

    setStatusByPromptId((p) => ({ ...p, [promptId]: "saving" }));

    const { data, error } = await supabase
      .from("submissions")
      .insert({
        hunt_id: huntId,
        player_id: playerId,
        prompt_id: promptId,
        photo_path: null,
      })
      .select("id")
      .single();

    if (error) {
      setStatusByPromptId((p) => ({ ...p, [promptId]: "error" }));
      throw error;
    }

    setSubmissionIdByPromptId((p) => ({ ...p, [promptId]: data.id }));
    setStatusByPromptId((p) => ({ ...p, [promptId]: "needs_photo" }));
    return data.id;
  }

  async function onPromptClick(promptId: string) {
    try {
      setActivePromptId(promptId);
      await ensureSubmission(promptId);
      fileInputRef.current?.click();
    } catch (e: any) {
      console.error("Failed on prompt click:", e);
      setStatusByPromptId((p) => ({ ...p, [promptId]: "error" }));
    }
  }

  async function onFileSelected(file: File | null) {
    if (!file || !activePromptId) return;

    const promptId = activePromptId;
    const submissionId = submissionIdByPromptId[promptId];

    if (!huntId || !playerId || !submissionId) {
      setStatusByPromptId((p) => ({ ...p, [promptId]: "error" }));
      return;
    }

    try {
      setStatusByPromptId((p) => ({ ...p, [promptId]: "uploading" }));

      const ext = getFileExt(file.name);
      const path = `${huntId}/${playerId}/${promptId}/${makeId()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("photos")
        .upload(path, file, { upsert: false });

      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from("submissions")
        .update({ photo_path: path })
        .eq("id", submissionId);

      if (updateError) throw updateError;

      setPhotoPathByPromptId((p) => ({ ...p, [promptId]: path }));
      setStatusByPromptId((p) => ({ ...p, [promptId]: "saved" }));

      const signedUrl = await getSignedUrlWithRetry(path);
      if (signedUrl) setPhotoUrlByPromptId((p) => ({ ...p, [promptId]: signedUrl }));
    } catch (e: any) {
      console.error("Upload failed:", e);
      setStatusByPromptId((p) => ({ ...p, [promptId]: "error" }));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setActivePromptId(null);
    }
  }

  // --------------------------
  // Progress
  // --------------------------
  const total = prompts.length;
  const completed = useMemo(
    () => prompts.reduce((acc, p) => acc + (photoPathByPromptId[p.id] ? 1 : 0), 0),
    [prompts, photoPathByPromptId]
  );

  // --------------------------
  // Player stats
  // --------------------------
  const playerCount = huntPlayers.length;
  const finishedCount = useMemo(
    () => huntPlayers.filter((p) => p.finished_at != null).length,
    [huntPlayers]
  );

  // --------------------------
  // Start game (any player can start)
  // --------------------------
  async function startGame() {
    if (!huntId) return;

    const { error } = await supabase
      .from("hunts")
      .update({ status: "active" })
      .eq("id", huntId);

    if (error) {
      setError(error.message);
      return;
    }

    // Update local state immediately (don't wait for real-time)
    setHunt((prev) => (prev ? { ...prev, status: "active" } : null));
  }

  // --------------------------
  // Load all submissions for voting phase
  // --------------------------
  useEffect(() => {
    if (hunt?.status !== "voting" || !huntId) return;

    (async () => {
      // Get all submissions for this hunt
      const { data: submissionsData, error: submissionsError } = await supabase
        .from("submissions")
        .select("id, prompt_id, player_id, photo_path")
        .eq("hunt_id", huntId);

      if (submissionsError) {
        console.error("Failed to load submissions for voting:", submissionsError);
        setError(submissionsError.message);
        return;
      }

      // Get display names from hunt_players
      const { data: playersData, error: playersError } = await supabase
        .from("hunt_players")
        .select("player_id, display_name")
        .eq("hunt_id", huntId);

      if (playersError) {
        console.error("Failed to load player names:", playersError);
      }

      // Create a map of player_id to display_name
      const playerNameMap: Record<string, string> = {};
      (playersData ?? []).forEach((p: { player_id: string; display_name: string | null }) => {
        playerNameMap[p.player_id] = p.display_name || "Anonymous";
      });

      // Transform the data to include display_name at the top level
      const submissions: Submission[] = (submissionsData ?? []).map((s: { id: string; prompt_id: string; player_id: string; photo_path: string }) => ({
        id: s.id,
        prompt_id: s.prompt_id,
        player_id: s.player_id,
        photo_path: s.photo_path,
        display_name: playerNameMap[s.player_id] || "Anonymous",
      }));

      setAllSubmissions(submissions);

      // Load signed URLs for all submissions
      const urls: Record<string, string> = {};
      for (const submission of submissions) {
        if (submission.photo_path) {
          const { data: urlData } = await supabase.storage
            .from("photos")
            .createSignedUrl(submission.photo_path, 3600);
          if (urlData?.signedUrl) {
            urls[submission.id] = urlData.signedUrl;
          }
        }
      }
      setSubmissionUrls(urls);

      // Reset voting state
      setCurrentPromptIndex(0);
      setVotedPromptIds(new Set());
    })();
  }, [hunt?.status, huntId]);

  // Note: Timer removed - voting is now manual (user clicks Vote or Skip)

  // --------------------------
  // Load results when hunt is finished
  // --------------------------
  useEffect(() => {
    if (hunt?.status !== "finished" || !huntId) return;

    (async () => {
      // Get all submissions for this hunt
      const { data: submissionsData, error: submissionsError } = await supabase
        .from("submissions")
        .select("id, prompt_id, player_id, photo_path")
        .eq("hunt_id", huntId);

      if (submissionsError) {
        console.error("Failed to load submissions for results:", submissionsError);
        return;
      }

      // Get display names from hunt_players
      const { data: playersData, error: playersError } = await supabase
        .from("hunt_players")
        .select("player_id, display_name")
        .eq("hunt_id", huntId);

      if (playersError) {
        console.error("Failed to load player names for results:", playersError);
      }

      // Create a map of player_id to display_name
      const playerNameMap: Record<string, string> = {};
      (playersData ?? []).forEach((p: { player_id: string; display_name: string | null }) => {
        playerNameMap[p.player_id] = p.display_name || "Anonymous";
      });

      // Get vote counts per submission
      const { data: voteCountsData, error: voteCountsError } = await supabase
        .from("votes")
        .select("submission_id");

      if (voteCountsError) {
        console.error("Failed to load vote counts:", voteCountsError);
        return;
      }

      // Count votes per submission
      const voteCountMap: Record<string, number> = {};
      (voteCountsData ?? []).forEach((v: { submission_id: string }) => {
        voteCountMap[v.submission_id] = (voteCountMap[v.submission_id] || 0) + 1;
      });

      // Build prompt winners
      const promptWinners: Array<{
        prompt: Prompt;
        winner: { display_name: string; votes: number; photo_url: string } | null;
      }> = [];

      // Build leaderboard (votes per player)
      const playerVotes: Record<string, { display_name: string; total_votes: number }> = {};

      // Load photo URLs and build player vote counts
      const photoUrls: Record<string, string> = {};
      for (const sub of submissionsData ?? []) {
        if (sub.photo_path) {
          const { data: urlData } = await supabase.storage
            .from("photos")
            .createSignedUrl(sub.photo_path, 3600);
          if (urlData?.signedUrl) {
            photoUrls[sub.id] = urlData.signedUrl;
          }
        }

        // Track votes per player
        const playerDisplayName = playerNameMap[sub.player_id] || "Anonymous";
        const votes = voteCountMap[sub.id] || 0;
        
        if (!playerVotes[sub.player_id]) {
          playerVotes[sub.player_id] = { display_name: playerDisplayName, total_votes: 0 };
        }
        playerVotes[sub.player_id].total_votes += votes;
      }

      // Find winner for each prompt
      for (const prompt of prompts) {
        const promptSubs = (submissionsData ?? []).filter(
          (s: { prompt_id: string }) => s.prompt_id === prompt.id
        );
        
        let maxVotes = 0;
        let winner = null;

        for (const sub of promptSubs) {
          const votes = voteCountMap[sub.id] || 0;
          const winnerDisplayName = playerNameMap[sub.player_id] || "Anonymous";
          
          if (votes > maxVotes) {
            maxVotes = votes;
            winner = {
              display_name: winnerDisplayName,
              votes,
              photo_url: photoUrls[sub.id] || "",
            };
          }
        }

        promptWinners.push({ prompt, winner });
      }

      // Sort leaderboard by total votes
      const leaderboard = Object.values(playerVotes).sort(
        (a, b) => b.total_votes - a.total_votes
      );

      setResults({ promptWinners, leaderboard });
    })();
  }, [hunt?.status, huntId, prompts]);

  // Get prompts that have at least one submission
  const promptsWithSubmissions = useMemo(() => {
    return prompts.filter((prompt) =>
      allSubmissions.some((s) => s.prompt_id === prompt.id)
    );
  }, [prompts, allSubmissions]);

  function advanceToNextPrompt() {
    const currentPrompt = promptsWithSubmissions[currentPromptIndex];
    if (!currentPrompt) return;

    // Mark as voted (even if no vote cast)
    setVotedPromptIds((prev) => new Set(prev).add(currentPrompt.id));

    // Move to next prompt or finish
    if (currentPromptIndex < promptsWithSubmissions.length - 1) {
      setCurrentPromptIndex((prev) => prev + 1);
    } else {
      // All prompts voted - transition to finished
      transitionToFinished();
    }
  }

  async function transitionToFinished() {
    if (!huntId) return;

    const { error } = await supabase
      .from("hunts")
      .update({ status: "finished" })
      .eq("id", huntId);

    if (error) {
      console.error("Failed to finish hunt:", error);
      return;
    }

    setHunt((prev) => (prev ? { ...prev, status: "finished" } : prev));
  }

  async function castVote(submissionId: string) {
    if (!playerId) return;

    // Insert vote into database
    const { error } = await supabase.from("votes").insert({
      submission_id: submissionId,
      player_id: playerId,
      category: "best",
    });

    if (error) {
      console.error("Failed to cast vote:", error);
      setError(error.message);
      return;
    }

    // Mark this prompt as voted and advance
    advanceToNextPrompt();
  }

  // --------------------------
  // Finish / Undo (persisted in hunt_players.finished_at)
  // --------------------------
  async function finishHunt() {
    if (!huntId || !playerId) return;

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("hunt_players")
      .update({ finished_at: now })
      .eq("hunt_id", huntId)
      .eq("player_id", playerId);

    if (error) {
      setError(error.message);
      return;
    }

    setFinishedAt(now);

    // Check if all players have finished - if so, transition to voting
    const { data: allPlayers, error: playersError } = await supabase
      .from("hunt_players")
      .select("finished_at")
      .eq("hunt_id", huntId);

    if (playersError) {
      console.error("Failed to check player status:", playersError);
      return;
    }

    const allFinished = allPlayers?.every((p) => p.finished_at != null);
    if (allFinished && allPlayers && allPlayers.length > 0) {
      // Transition hunt to voting phase
      const { error: statusError } = await supabase
        .from("hunts")
        .update({ status: "voting" })
        .eq("id", huntId);

      if (statusError) {
        console.error("Failed to transition to voting:", statusError);
        return;
      }

      // Update local state
      setHunt((prev) => (prev ? { ...prev, status: "voting" } : prev));
    }
  }

  async function undoFinish() {
    if (!huntId || !playerId) return;

    const { error } = await supabase
      .from("hunt_players")
      .update({ finished_at: null })
      .eq("hunt_id", huntId)
      .eq("player_id", playerId);

    if (error) {
      setError(error.message);
      return;
    }

    setFinishedAt(null);
  }

  // --------------------------
  // UI
  // --------------------------
  if (!huntId) {
    return (
      <main className="p-6 max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold mb-2">Photo Hunt</h1>
        <p className="text-gray-600 mb-2">
          The photo scavenger hunt for walking with friends. Submit your photos and vote for your favourites.
        </p>
        <p className="text-gray-500 text-sm mb-8">
          Create a new hunt (share the code with friends), or join a friend&apos;s hunt using their code.
        </p>

        {error && (
          <div className="mb-6 p-3 border border-red-300 text-red-700">
            Error: {error}
          </div>
        )}

        {/* Your Name */}
        <div className="border rounded p-6 mb-6">
          <h2 className="text-2xl font-semibold mb-4">Your Name</h2>
          <input
            className="border rounded p-3 w-full text-lg"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => savePlayerName(e.target.value)}
          />
        </div>

        <div className="border rounded p-6 mb-6">
          <h2 className="text-2xl font-semibold mb-4">Create a Hunt</h2>
          <div className="flex gap-3">
            <select
              className="border rounded p-3 flex-1 text-lg"
              value={createPack}
              onChange={(e) => setCreatePack(e.target.value)}
            >
              {availablePacks.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="px-6 py-3 bg-black text-white rounded" onClick={createHunt}>
              Create
            </button>
          </div>
          {getPackDescription(createPack) && (
            <div className="mt-3 text-sm text-gray-500">
              {getPackDescription(createPack)}
            </div>
          )}
          {getPackLocationInfo(createPack) && (
            <div className="mt-2 text-sm text-gray-400 flex items-center gap-1">
              <span>📍</span>
              {getPackLocationInfo(createPack)?.area && (
                <span>{getPackLocationInfo(createPack)?.area}</span>
              )}
              {getPackLocationInfo(createPack)?.area && getPackLocationInfo(createPack)?.distance && (
                <span>·</span>
              )}
              {getPackLocationInfo(createPack)?.distance && (
                <span>~{getPackLocationInfo(createPack)?.distance} km</span>
              )}
            </div>
          )}
        </div>

        <div className="border rounded p-6 mb-6">
          <h2 className="text-2xl font-semibold mb-4">Join a Hunt</h2>
          <div className="flex gap-3">
            <input
              className="border rounded p-3 flex-1 text-lg"
              placeholder="ENTER CODE"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            />
            <button className="px-6 py-3 bg-black text-white rounded" onClick={joinHuntByCode}>
              Join
            </button>
          </div>
        </div>

        {/* Your Hunts (history) */}
        {playerGames.length > 0 && (
          <div className="border rounded p-6">
            <h2 className="text-2xl font-semibold mb-4">Your Hunts</h2>
            <div className="space-y-3">
              {playerGames.map((game) => (
                <div
                  key={game.hunt_id}
                  className="flex items-center justify-between p-3 border rounded"
                >
                  <div>
                    <div className="font-mono font-bold text-lg">{game.hunt_code}</div>
                    <div className="text-sm text-gray-500">
                      {getPackName(game.pack)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Status badge */}
                    <span
                      className={`text-xs px-2 py-1 rounded-full ${
                        game.hunt_status === "lobby"
                          ? "bg-yellow-100 text-yellow-800"
                          : game.hunt_status === "active"
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {game.hunt_status}
                    </span>
                    {/* Actions */}
                    {game.hunt_status !== "finished" && (
                      <button
                        className="px-3 py-1 bg-black text-white text-sm rounded"
                        onClick={() => resumeGame(game.hunt_id)}
                      >
                        Resume
                      </button>
                    )}
                    <button
                      className="px-3 py-1 border text-sm rounded text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => leaveGame(game.hunt_id)}
                    >
                      Leave
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    );
  }

  // --------------------------
  // Lobby / Waiting Room UI
  // --------------------------
  if (hunt?.status === "lobby") {
    return (
      <main className="p-6 max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-4xl font-bold">Waiting Room</h1>
          <button className="text-sm underline text-gray-600" onClick={changeHunt}>
            Leave
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 border border-red-300 text-red-700">
            Error: {error}
          </div>
        )}

        {/* Share code */}
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded text-center">
          <div className="text-sm text-blue-700 mb-1">
            Share this code with friends
          </div>
          <div className="text-4xl font-mono font-bold text-blue-900 tracking-widest">
            {hunt.code}
          </div>
        </div>

        {/* Pack info */}
        {hunt.pack && (
          <div className="mb-6 p-4 bg-gray-50 rounded border">
            <div className="text-sm text-gray-500 mb-1">Pack</div>
            <div className="text-lg font-semibold">{getPackName(hunt.pack)}</div>
            {getPackDescription(hunt.pack) && (
              <div className="text-sm text-gray-600 mt-1">{getPackDescription(hunt.pack)}</div>
            )}
            <div className="text-sm text-gray-400 mt-1">{prompts.length} prompts</div>
          </div>
        )}

        {/* Players list */}
        <div className="mb-6">
          <div className="text-sm text-gray-500 mb-2">
            Players ({playerCount})
          </div>
          <div className="space-y-2">
            {huntPlayers.map((p) => {
              const isCurrentPlayer = p.player_id === playerId;
              return (
                <div
                  key={p.id}
                  className={`flex items-center justify-between p-3 border rounded ${
                    isCurrentPlayer ? "bg-blue-50 border-blue-200" : "bg-white"
                  }`}
                >
                  {isCurrentPlayer && isEditingName ? (
                    <div className="flex gap-2 flex-1">
                      <input
                        className="border rounded px-2 py-1 flex-1"
                        value={editingNameValue}
                        onChange={(e) => setEditingNameValue(e.target.value)}
                        placeholder="Your name"
                        autoFocus
                      />
                      <button
                        className="px-3 py-1 bg-black text-white rounded text-sm"
                        onClick={() => updateDisplayName(editingNameValue)}
                      >
                        Save
                      </button>
                      <button
                        className="px-3 py-1 border rounded text-sm"
                        onClick={() => setIsEditingName(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {p.display_name || "Anonymous"}
                        </span>
                        {isCurrentPlayer && (
                          <span className="text-xs text-blue-600">(You)</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isCurrentPlayer && (
                          <button
                            className="text-xs text-blue-600 underline"
                            onClick={() => {
                              setEditingNameValue(p.display_name || "");
                              setIsEditingName(true);
                            }}
                          >
                            Edit
                          </button>
                        )}
                        {p.role === "host" && (
                          <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-800 rounded-full">
                            Host
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Start button */}
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t">
          <div className="max-w-xl mx-auto p-4">
            <button
              className="w-full py-4 bg-green-600 text-white rounded font-semibold text-lg"
              onClick={startGame}
            >
              Start Game
            </button>
          </div>
        </div>
      </main>
    );
  }

  // --------------------------
  // Voting UI
  // --------------------------
  if (hunt?.status === "voting") {
    // If no prompts have submissions, go straight to results
    if (promptsWithSubmissions.length === 0) {
      return (
        <main className="p-6 max-w-xl mx-auto">
          <h1 className="text-4xl font-bold mb-4">Voting</h1>
          <div className="text-center py-8 text-gray-500">
            No photos were submitted. Finishing hunt...
          </div>
          <button
            className="w-full py-4 bg-black text-white rounded"
            onClick={transitionToFinished}
          >
            View Results
          </button>
        </main>
      );
    }

    const currentPrompt = promptsWithSubmissions[currentPromptIndex];
    const promptSubmissions = allSubmissions.filter(
      (s) => s.prompt_id === currentPrompt?.id
    );

    return (
      <main className="p-6 max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-4xl font-bold">Voting</h1>
          <div className="text-sm text-gray-500">
            {currentPromptIndex + 1} / {promptsWithSubmissions.length}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 border border-red-300 text-red-700">
            Error: {error}
          </div>
        )}

        {/* Current prompt */}
        {currentPrompt && (
          <div className="mb-6 p-4 bg-gray-50 rounded border text-center">
            <div className="text-sm text-gray-500 mb-1">Vote for the best photo of:</div>
            <div className="text-lg font-semibold">{currentPrompt.text}</div>
          </div>
        )}

        {/* Photo gallery for this prompt */}
        <div className="space-y-4">
          {promptSubmissions.map((submission) => {
            const isOwnSubmission = submission.player_id === playerId;
            const hasVoted = votedPromptIds.has(currentPrompt?.id ?? "");

            return (
              <div
                key={submission.id}
                className={`border rounded overflow-hidden ${
                  isOwnSubmission ? "opacity-50" : ""
                }`}
              >
                {submissionUrls[submission.id] && (
                  <img
                    src={submissionUrls[submission.id]}
                    alt={`${submission.display_name}'s photo`}
                    className="w-full h-48 object-cover"
                  />
                )}
                <div className="p-3 flex items-center justify-between bg-white">
                  <span className="font-medium">{submission.display_name}</span>
                  {!isOwnSubmission && !hasVoted && (
                    <button
                      className="px-4 py-2 bg-green-600 text-white rounded"
                      onClick={() => castVote(submission.id)}
                    >
                      Vote
                    </button>
                  )}
                  {isOwnSubmission && (
                    <span className="text-sm text-gray-400">Your photo</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Skip button */}
        <div className="mt-6">
          <button
            className="w-full py-3 border border-gray-300 rounded text-gray-600"
            onClick={advanceToNextPrompt}
          >
            Skip this prompt
          </button>
        </div>
      </main>
    );
  }

  // --------------------------
  // Results UI
  // --------------------------
  if (hunt?.status === "finished") {
    return (
      <main className="p-6 max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-4xl font-bold">Results</h1>
          <button className="text-sm underline text-gray-600" onClick={changeHunt}>
            Exit
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 border border-red-300 text-red-700">
            Error: {error}
          </div>
        )}

        {!results ? (
          <div className="text-center py-8 text-gray-500">Loading results...</div>
        ) : (
          <>
            {/* Leaderboard */}
            <div className="mb-8">
              <h2 className="text-2xl font-semibold mb-4">Leaderboard</h2>
              <div className="space-y-2">
                {results.leaderboard.map((player, index) => (
                  <div
                    key={player.display_name}
                    className={`flex items-center justify-between p-4 rounded border ${
                      index === 0
                        ? "bg-yellow-50 border-yellow-300"
                        : index === 1
                        ? "bg-gray-100 border-gray-300"
                        : index === 2
                        ? "bg-orange-50 border-orange-300"
                        : "bg-white"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`text-2xl font-bold ${
                          index === 0
                            ? "text-yellow-600"
                            : index === 1
                            ? "text-gray-500"
                            : index === 2
                            ? "text-orange-600"
                            : "text-gray-400"
                        }`}
                      >
                        #{index + 1}
                      </span>
                      <span className="font-medium">{player.display_name}</span>
                    </div>
                    <div className="text-lg font-semibold">
                      {player.total_votes} vote{player.total_votes !== 1 ? "s" : ""}
                    </div>
                  </div>
                ))}
                {results.leaderboard.length === 0 && (
                  <div className="text-center text-gray-500 py-4">
                    No votes were cast
                  </div>
                )}
              </div>
            </div>

            {/* Prompt Winners */}
            <div className="mb-8">
              <h2 className="text-2xl font-semibold mb-4">Best Photos</h2>
              <div className="space-y-4">
                {results.promptWinners.map(({ prompt, winner }) => (
                  <div key={prompt.id} className="border rounded overflow-hidden">
                    <div className="p-3 bg-gray-50 border-b">
                      <div className="font-medium">{prompt.text}</div>
                    </div>
                    {winner ? (
                      <div>
                        {winner.photo_url && (
                          <img
                            src={winner.photo_url}
                            alt={`${winner.display_name}'s winning photo`}
                            className="w-full h-48 object-cover"
                          />
                        )}
                        <div className="p-3 flex items-center justify-between">
                          <span className="font-medium">{winner.display_name}</span>
                          <span className="text-sm text-green-600">
                            {winner.votes} vote{winner.votes !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 text-center text-gray-500">
                        No winner
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Return home button */}
            <button
              className="w-full py-4 bg-black text-white rounded font-semibold text-lg"
              onClick={changeHunt}
            >
              Return Home
            </button>
          </>
        )}
      </main>
    );
  }

  // --------------------------
  // Active Hunt UI
  // --------------------------
  return (
    <main className="p-6 max-w-xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-4xl font-bold">Photo Hunt</h1>
        <button className="text-sm underline text-gray-600" onClick={changeHunt}>
          Change hunt
        </button>
      </div>

      {hunt?.pack && (
        <div className="mb-4 p-3 bg-gray-50 rounded border">
          <div className="text-sm text-gray-500">Pack</div>
          <div className="font-medium text-gray-900">{getPackName(hunt.pack)}</div>
          {getPackDescription(hunt.pack) && (
            <div className="text-sm text-gray-600 mt-1">{getPackDescription(hunt.pack)}</div>
          )}
        </div>
      )}

      {/* Players in hunt */}
      {playerCount > 0 && (
        <div className="mb-4 p-3 bg-gray-50 rounded border">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">
              <span className="font-medium text-gray-900">{playerCount}</span>{" "}
              {playerCount === 1 ? "player" : "players"} in hunt
            </span>
            <span className="text-gray-500">
              {finishedCount} / {playerCount} finished
            </span>
          </div>
          {huntPlayers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {huntPlayers.map((p) => (
                <span
                  key={p.id}
                  className={`text-xs px-2 py-1 rounded-full ${
                    p.finished_at
                      ? "bg-green-100 text-green-700"
                      : "bg-gray-200 text-gray-600"
                  }`}
                >
                  {p.display_name || "Anonymous"}
                  {p.finished_at && " ✓"}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Progress */}
      {total > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>
              Completed{" "}
              <span className="font-medium text-gray-900">{completed}</span> /{" "}
              <span className="font-medium text-gray-900">{total}</span>
            </span>
            {finishedAt ? (
              <span className="text-green-700 font-medium">Finished ✅</span>
            ) : (
              <span className="text-gray-500">In progress</span>
            )}
          </div>

          <div className="mt-2 h-2 w-full rounded bg-gray-200">
            <div
              className="h-2 rounded bg-green-600 transition-all"
              style={{ width: total === 0 ? "0%" : `${(completed / total) * 100}%` }}
            />
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => onFileSelected(e.target.files?.[0] ?? null)}
      />

      {error && (
        <div className="mb-4 p-3 border border-red-300 text-red-700">
          Error: {error}
        </div>
      )}

      <ul className="space-y-3 pb-24">
        {prompts.map((p) => {
          const status = statusByPromptId[p.id] ?? "idle";
          const isBusy = status === "saving" || status === "uploading";

          // Contextual label based on status
          const statusLabel = {
            idle: "Take a photo of:",
            saving: "Saving...",
            needs_photo: "Tap to add photo:",
            uploading: "Uploading...",
            saved: "Photo taken!",
            error: "Error - tap to retry:",
          }[status];

          const statusColor = {
            idle: "text-gray-500",
            saving: "text-yellow-600",
            needs_photo: "text-blue-600",
            uploading: "text-yellow-600",
            saved: "text-green-600",
            error: "text-red-600",
          }[status];

          return (
            <li
              key={p.id}
              className={`p-3 border rounded cursor-pointer ${isBusy ? "opacity-60 cursor-wait" : ""}`}
              onClick={() => {
                if (!isBusy) onPromptClick(p.id);
              }}
            >
              <div className={`text-xs font-medium mb-1 ${statusColor}`}>
                {statusLabel}
              </div>

              <div className="font-medium text-lg">{p.text}</div>

              {photoUrlByPromptId[p.id] && (
                <div className="mt-2">
                  <img className="w-full rounded border" alt="submission" src={photoUrlByPromptId[p.id]} />
                  <button
                    className="mt-2 text-sm text-blue-600 underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPromptClick(p.id);
                    }}
                  >
                    Retake photo
                  </button>
                </div>
              )}

              {!photoUrlByPromptId[p.id] && photoPathByPromptId[p.id] && (
                <div className="mt-2 text-xs text-gray-500">Photo attached (loading preview...)</div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Bottom buttons (requested) */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t">
        <div className="max-w-xl mx-auto p-4">
          {!finishedAt ? (
            <button className="w-full py-4 bg-black text-white rounded" onClick={finishHunt}>
              Finish Hunt
            </button>
          ) : (
            <button className="w-full py-4 bg-gray-200 text-black rounded" onClick={undoFinish}>
              Undo Finish
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
