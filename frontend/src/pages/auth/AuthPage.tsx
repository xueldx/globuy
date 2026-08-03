import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/authStore";

type AuthMode = "login" | "register";

function AuthPage({ mode }: { mode: AuthMode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const busy = useAuthStore((state) => state.busy);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const isLogin = mode === "login";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("请填写邮箱和密码");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("请输入有效的邮箱地址");
      return;
    }
    if (!isLogin && !displayName.trim()) {
      setError("请填写显示名称");
      return;
    }
    if (password.length < 8) {
      setError("密码至少需要 8 个字符");
      return;
    }
    try {
      if (isLogin) await login(email.trim(), password);
      else await register(email.trim(), displayName.trim(), password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from?.startsWith("/") ? from : "/", { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "暂时无法连接服务器，请稍后重试");
    }
  };

  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,1.05fr)_minmax(26rem,0.95fr)]">
      <section className="relative hidden overflow-hidden bg-slate-950 p-12 text-slate-100 lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden="true" className="absolute -right-32 top-20 h-72 w-72 rounded-full bg-primary/35 blur-3xl" />
        <p className="relative text-sm font-semibold tracking-wide">GLOBUY / AGENT COMMERCE</p>
        <div className="relative max-w-xl">
          <p className="mb-5 text-xs font-medium uppercase tracking-[0.22em] text-slate-400">
            登录后的每一次生成都有明确归属
          </p>
          <h1 className="text-balance text-4xl font-semibold leading-tight">
            你的会话、偏好和生成任务，只回到你的账户。
          </h1>
          <p className="mt-6 max-w-lg text-pretty text-sm leading-7 text-slate-400">
            身份校验发生在服务端。创建任务、恢复流式回答和取消生成时，系统都会重新确认资源归属。
          </p>
        </div>
        <p className="relative text-xs text-slate-500">Session 只保存在受保护的浏览器 Cookie 中</p>
      </section>

      <section className="flex min-h-screen items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <Link to="/" className="text-sm font-semibold text-foreground lg:hidden">
            Globuy 跨境购物助手
          </Link>
          <p className="mt-10 text-xs font-medium uppercase tracking-[0.18em] text-primary lg:mt-0">
            {isLogin ? "继续对话" : "创建账户"}
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            {isLogin ? "欢迎回来" : "开始你的购物会话"}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            {isLogin ? "登录后恢复属于你的会话和未完成生成。" : "注册后，会话与偏好会绑定到这个账户。"}
          </p>

          <form className="mt-8 space-y-5" onSubmit={submit} noValidate>
            {!isLogin && (
              <Field label="显示名称" htmlFor="display-name">
                <input
                  id="display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  maxLength={40}
                  className={inputClass}
                  placeholder="面试复盘时显示的名字"
                />
              </Field>
            )}
            <Field label="邮箱" htmlFor="email">
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                maxLength={254}
                className={inputClass}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="密码" htmlFor="password">
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={isLogin ? "current-password" : "new-password"}
                minLength={8}
                maxLength={128}
                className={inputClass}
                placeholder="至少 8 个字符"
              />
            </Field>

            {error && (
              <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm leading-6 text-red-700 dark:text-red-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="min-h-11 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-[transform,opacity] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "正在处理…" : isLogin ? "登录" : "注册并登录"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted">
            {isLogin ? "还没有账户？" : "已经有账户？"}{" "}
            <Link
              to={isLogin ? "/register" : "/login"}
              className="font-medium text-primary underline decoration-primary/30 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              {isLogin ? "去注册" : "去登录"}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-foreground shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted/60 focus:border-primary/60 focus:ring-4 focus:ring-primary/10";

export function LoginPage() {
  return <AuthPage mode="login" />;
}

export function RegisterPage() {
  return <AuthPage mode="register" />;
}
