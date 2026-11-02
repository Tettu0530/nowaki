import { useEffect, useRef, useState } from "preact/hooks";
import { addTodo, addTodoForm, listTodos, whoami } from "../actions/todos.ts";

// A client island calling server functions over RPC. The browser only gets island JS + the proxy.
export default function ServerTodos({ initial = [] }: { initial?: string[] }) {
  const [todos, setTodos] = useState<string[]>(initial);
  const [text, setText] = useState("");
  const [who, setWho] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  // Takes the form action (<form action={addTodoForm}>) result, updates the list, and resets the form.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onAction = (e: Event) => {
      const result = (e as CustomEvent).detail?.result;
      if (Array.isArray(result)) setTodos(result);
      form.reset();
    };
    form.addEventListener("nowaki:action", onAction);
    return () => form.removeEventListener("nowaki:action", onAction);
  }, []);

  return (
    <div data-testid="server-todos" style="border:1px solid #ccc;padding:1rem;border-radius:8px">
      <button
        data-testid="whoami"
        type="button"
        onClick={async () => setWho(await whoami())}
      >
        whoami
      </button>{" "}
      <span data-testid="who">{who}</span>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          setTodos(await addTodo(t));
          setText("");
        }}
      >
        <input
          data-testid="todo-input"
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          placeholder="new todo"
        />{" "}
        <button data-testid="add" type="submit">add</button>
      </form>
      {/* Pass a server function directly as the form action (React 19 style). On submit, FormData
          goes to the server function, which runs on the server. */}
      <form action={addTodoForm} ref={formRef} data-testid="fa-form">
        <input data-testid="fa-input" name="text" placeholder="todo via form action" />{" "}
        <button data-testid="fa-add" type="submit">add (form action)</button>
      </form>
      <ul data-testid="todo-list">
        {todos.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
      <button
        data-testid="refresh"
        type="button"
        onClick={async () => setTodos(await listTodos())}
      >
        refresh
      </button>
    </div>
  );
}
