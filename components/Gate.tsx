"use client";

import { AuthLoading, Authenticated, Unauthenticated } from "convex/react";
import Cockpit from "./Cockpit";
import SignIn from "./SignIn";

/**
 * Nothing renders until Convex has decided who you are.
 *
 * `AuthLoading` matters more than it looks: without it there is a frame where
 * the token hasn't been checked yet, the app reads as signed out, and the
 * sign-in screen flashes at someone who is already signed in.
 */
export default function Gate() {
  return (
    <>
      <AuthLoading>
        <div className="flex h-full items-center justify-center bg-bg">
          <span className="text-faint">
            checking session<span className="caret">_</span>
          </span>
        </div>
      </AuthLoading>

      <Unauthenticated>
        <SignIn />
      </Unauthenticated>

      <Authenticated>
        <Cockpit />
      </Authenticated>
    </>
  );
}
