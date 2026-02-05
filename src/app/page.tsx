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
  status: "lobby" | "active" | "finished";
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

  // Hunt selection
  const [huntId, setHuntId] = useState<string | null>(null);
  const [hunt, setHunt] = useState<Hunt | null>(null);

  // Create/Join UI
  const [availablePacks, setAvailablePacks] = useState<string[]>([]);
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

  // upload flow
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --------------------------
  // Boot: load local storage
  // --------------------------
  useEffect(() => {
    const storedHuntId = localStorage.getItem("hunt_id");
    if (storedHuntId) setHuntId(storedHuntId);

    const storedPlayerId = localStorage.getItem("player_id");
    if (storedPlayerId) setPlayerId(storedPlayerId);
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
  // Load available packs from prompts
  // --------------------------
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("prompts").select("pack");
      if (error) {
        console.error("Failed to load packs:", error);
        setError(error.message);
        return;
      }

      const packs = Array.from(
        new Set((data ?? []).map((r: any) => r.pack).filter(Boolean))
      ) as string[];

      packs.sort((a, b) => a.localeCompare(b));

      setAvailablePacks(packs);

      // default selection
      if (!createPack && packs.length > 0) setCreatePack(packs[0]);
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

      // Only insert if not already a member
      if (!existing) {
        const { error: insertError } = await supabase
          .from("hunt_players")
          .insert({
            hunt_id: huntId,
            player_id: playerId,
            display_name: "anon",
            role: "player",
          });

        if (insertError) {
          console.error("Failed to join hunt:", insertError);
          setError(insertError.message);
          return;
        }

        // Fetch the newly inserted row
        const { data: newRow, error: fetchError } = await supabase
          .from("hunt_players")
          .select("finished_at, role")
          .eq("hunt_id", huntId)
          .eq("player_id", playerId)
          .single();

        if (fetchError) {
          console.error("Failed to load player data:", fetchError);
          return;
        }

        setFinishedAt(newRow?.finished_at ?? null);
        setIsHost(newRow?.role === "host");
      } else {
        // Already a member, just use the existing data
        setFinishedAt(existing.finished_at ?? null);
        setIsHost(existing.role === "host");
      }
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
          display_name: "anon",
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
  // Start game (host only)
  // --------------------------
  async function startGame() {
    if (!huntId || !isHost) return;

    const { error } = await supabase
      .from("hunts")
      .update({ status: "active" })
      .eq("id", huntId);

    if (error) {
      setError(error.message);
    }
    // No need to setHunt here - real-time subscription will update it
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
        <p className="text-gray-600 mb-8">
          Create a new hunt (share the code), or join one with a code.
        </p>

        {error && (
          <div className="mb-6 p-3 border border-red-300 text-red-700">
            Error: {error}
          </div>
        )}

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

        <div className="border rounded p-6">
          <h2 className="text-2xl font-semibold mb-4">Create New Hunt</h2>

          <label className="block text-gray-700 mb-2">Pack</label>
          <select
            className="border rounded p-3 w-full mb-4"
            value={createPack}
            onChange={(e) => setCreatePack(e.target.value)}
          >
            {availablePacks.map((p) => (
              <option key={p} value={p}>
                {packLabel(p)} ({p})
              </option>
            ))}
          </select>

          <label className="block text-gray-700 mb-2">Completion mode</label>
          <select
            className="border rounded p-3 w-full mb-4"
            value={createCompletionMode}
            onChange={(e) => setCreateCompletionMode(e.target.value as any)}
          >
            <option value="anytime">anytime (finish whenever)</option>
            <option value="all_required">all_required (must complete required photos)</option>
          </select>

          <label className="block text-gray-700 mb-2">Required prompt count (optional)</label>
          <input
            className="border rounded p-3 w-full mb-6"
            placeholder="leave blank to require all prompts"
            value={createRequiredCount}
            onChange={(e) => setCreateRequiredCount(e.target.value)}
          />

          <button className="px-6 py-3 bg-black text-white rounded" onClick={createHunt}>
            Create Hunt
          </button>
        </div>
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
            <div className="text-lg font-semibold">{packLabel(hunt.pack)}</div>
            <div className="text-sm text-gray-400">{prompts.length} prompts</div>
          </div>
        )}

        {/* Players list */}
        <div className="mb-6">
          <div className="text-sm text-gray-500 mb-2">
            Players ({playerCount})
          </div>
          <div className="space-y-2">
            {huntPlayers.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between p-3 bg-white border rounded"
              >
                <span className="font-medium">
                  {p.display_name || "Anonymous"}
                </span>
                {p.role === "host" && (
                  <span className="text-xs px-2 py-1 bg-yellow-100 text-yellow-800 rounded-full">
                    Host
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Start button or waiting message */}
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t">
          <div className="max-w-xl mx-auto p-4">
            {isHost ? (
              <button
                className="w-full py-4 bg-green-600 text-white rounded font-semibold text-lg"
                onClick={startGame}
              >
                Start Game
              </button>
            ) : (
              <div className="text-center py-4 text-gray-500">
                Waiting for host to start the game...
              </div>
            )}
          </div>
        </div>
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

      {/* Hunt code for sharing */}
      {hunt?.code && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded">
          <div className="text-sm text-blue-700">
            Share this code with friends:
          </div>
          <div className="text-2xl font-mono font-bold text-blue-900 tracking-wider">
            {hunt.code}
          </div>
        </div>
      )}

      {hunt?.pack && (
        <div className="text-sm text-gray-600 mb-4">
          Pack: <span className="font-medium text-gray-900">{packLabel(hunt.pack)}</span>{" "}
          <span className="text-gray-400">({hunt.pack})</span>
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

          return (
            <li
              key={p.id}
              className={`p-3 border rounded cursor-pointer ${isBusy ? "opacity-60 cursor-wait" : ""}`}
              onClick={() => {
                if (!isBusy) onPromptClick(p.id);
              }}
            >
              <div className="text-xs text-gray-500 flex items-center justify-between">
                <span>{p.pack}</span>

                {status === "saving" && <span>Saving…</span>}
                {status === "needs_photo" && <span>Selected ✅ (tap to add photo)</span>}
                {status === "uploading" && <span>Uploading…</span>}
                {status === "saved" && <span>Saved ✅</span>}
                {status === "error" && <span className="text-red-700">Error ❌</span>}
              </div>

              <div className="font-medium">{p.text}</div>

              {photoUrlByPromptId[p.id] && (
                <div className="mt-2">
                  <img className="w-full rounded border" alt="submission" src={photoUrlByPromptId[p.id]} />
                </div>
              )}

              {!photoUrlByPromptId[p.id] && photoPathByPromptId[p.id] && (
                <div className="mt-2 text-xs text-gray-500">Photo attached (loading preview…)</div>
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
