import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { fetchCurrentUser, signOut } from "../../services/auth";

/**
 * The signed-in user for the shell's account corner, and its logout. The
 * route already guards the role; this is only what the chrome displays.
 */
export default function useShellProfile() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    let live = true;
    fetchCurrentUser()
      .then((data) => {
        if (live && data) setProfile(data);
      })
      .catch((err) => console.error("Load profile error:", err));
    return () => {
      live = false;
    };
  }, []);

  const logout = useCallback(async () => {
    await signOut();
    navigate("/login", { replace: true });
  }, [navigate]);

  return { profile, logout };
}
