import { createContext, memo, useCallback, useContext, useMemo, useState } from "react";
import { useTrackedContextValue, useTrackedState } from "react-render-detective";
import { CATEGORIES, queryProducts, type Product } from "./data";

/* ------------------------------------------------------------------ context */

interface Session {
  user: { id: number; name: string };
  theme: "light" | "dark";
  toggleTheme: () => void;
}

const SessionContext = createContext<Session | undefined>(undefined);
const useSession = (): Session => useContext(SessionContext) as Session;

/**
 * PROBLEM 1 — unstable provider value.
 * The value object is rebuilt on every render of SessionProvider, so every
 * consumer re-renders even when nothing they read has changed.
 */
function SessionProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const value: Session = {
    user: { id: 42, name: "Ada" },
    theme,
    toggleTheme: () => setTheme((t) => (t === "light" ? "dark" : "light")),
  };
  useTrackedContextValue("SessionContext", value);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/* ------------------------------------------------------------------- pieces */

function Navbar({ onOpenModal }: { onOpenModal: () => void }) {
  const { user, theme, toggleTheme } = useSession();
  return (
    <header className="navbar">
      <strong>Acme Admin</strong>
      <span className="spacer" />
      <button onClick={toggleTheme}>{theme === "light" ? "Dark" : "Light"} mode</button>
      <button onClick={onOpenModal}>New product</button>
      <span className="user">{user.name}</span>
    </header>
  );
}

function Sidebar({ active }: { active: string }) {
  const items = ["Overview", "Products", "Orders", "Customers", "Settings"];
  return (
    <nav className="sidebar">
      {items.map((item) => (
        <a key={item} className={item === active ? "active" : ""}>
          {item}
        </a>
      ))}
    </nav>
  );
}

/**
 * PROBLEM 2 — expensive component with no memoization.
 * Chart re-renders whenever Dashboard does, and each render costs real time.
 */
function Chart({ rows }: { rows: Product[] }) {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    // Deliberately wasteful, to make the cost visible in the timings.
    for (let i = 0; i < 400; i++) Math.sqrt(row.price + i);
    buckets.set(row.category, (buckets.get(row.category) ?? 0) + row.price);
  }
  const max = Math.max(1, ...buckets.values());
  return (
    <section className="chart">
      {[...buckets.entries()].map(([category, total]) => (
        <div key={category} className="bar">
          <span className="bar-label">{category}</span>
          <span className="bar-fill" style={{ width: `${(total / max) * 100}%` }} />
          <span className="bar-value">{Math.round(total)}</span>
        </div>
      ))}
    </section>
  );
}

const TableRow = memo(
  function TableRow({
    product,
    onSelect,
  }: {
    product: Product;
    onSelect: (id: number) => void;
  }) {
    return (
      <tr onClick={() => onSelect(product.id)}>
        <td>{product.name}</td>
        <td>{product.category}</td>
        <td className="num">{product.price.toFixed(2)}</td>
        <td className="num">{product.stock}</td>
        <td>{product.updatedAt}</td>
      </tr>
    );
  },
);

/**
 * PROBLEM 3 — a memoized row list defeated by an unstable callback.
 * `onSelect` is recreated by ProductTable on every render, so `memo` on
 * TableRow never gets a chance to skip anything.
 */
function ProductTable({
  rows,
  page,
  onSelect,
}: {
  rows: Product[];
  page: number;
  onSelect: (id: number) => void;
}) {
  const pageRows = rows.slice(page * 20, page * 20 + 20);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th className="num">Price</th>
          <th className="num">Stock</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {pageRows.map((product) => (
          <TableRow key={product.id} product={product} onSelect={onSelect} />
        ))}
      </tbody>
    </table>
  );
}

function Filters({
  query,
  category,
  onQuery,
  onCategory,
}: {
  query: string;
  category: string;
  onQuery: (v: string) => void;
  onCategory: (v: string) => void;
}) {
  return (
    <div className="filters">
      <input placeholder="Search products" value={query} onChange={(e) => onQuery(e.target.value)} />
      <select value={category} onChange={(e) => onCategory(e.target.value)}>
        {["All", ...CATEGORIES].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}

function Pagination({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="pagination">
      <button disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page + 1} of {pages}
      </span>
      <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

function Modal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New product</h3>
        <p>Nothing here — the point is what the detective says about the renders around it.</p>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- dashboard */

function Dashboard() {
  const [query, setQuery] = useTrackedState("query", "");
  const [category, setCategory] = useTrackedState("category", "All");
  const [page, setPage] = useTrackedState("page", 0);
  const [modalOpen, setModalOpen] = useState(false);

  // PROBLEM 4 — recomputed and reallocated on every render, including renders
  // caused by an unrelated state change such as opening the modal.
  const rows = queryProducts(query, category);
  const pages = Math.max(1, Math.ceil(rows.length / 20));

  // PROBLEM 5 — a new function identity on every render.
  const handleSelect = (id: number) => console.log("selected", id);

  return (
    <div className="layout">
      <Navbar onOpenModal={() => setModalOpen(true)} />
      <div className="body">
        <Sidebar active="Products" />
        <main>
          <Filters query={query} category={category} onQuery={setQuery} onCategory={setCategory} />
          <Chart rows={rows} />
          <ProductTable rows={rows} page={Math.min(page, pages - 1)} onSelect={handleSelect} />
          <Pagination page={Math.min(page, pages - 1)} pages={pages} onPage={setPage} />
        </main>
      </div>
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

/* ------------------------------------------------------- the fixed version */

function FixedDashboard() {
  const [query, setQuery] = useTrackedState("query", "");
  const [category, setCategory] = useTrackedState("category", "All");
  const [page, setPage] = useTrackedState("page", 0);
  const [modalOpen, setModalOpen] = useState(false);

  const rows = useMemo(() => queryProducts(query, category), [query, category]);
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const handleSelect = useCallback((id: number) => console.log("selected", id), []);
  const openModal = useCallback(() => setModalOpen(true), []);

  return (
    <div className="layout">
      <Navbar onOpenModal={openModal} />
      <div className="body">
        <Sidebar active="Products" />
        <main>
          <Filters query={query} category={category} onQuery={setQuery} onCategory={setCategory} />
          <Chart rows={rows} />
          <ProductTable rows={rows} page={Math.min(page, pages - 1)} onSelect={handleSelect} />
          <Pagination page={Math.min(page, pages - 1)} pages={pages} onPage={setPage} />
        </main>
      </div>
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

export function App() {
  const [fixed, setFixed] = useState(false);
  return (
    <SessionProvider>
      <div className="app">
        <div className="banner">
          <span>
            Showing the <strong>{fixed ? "fixed" : "deliberately broken"}</strong> dashboard. Open the
            console, or the overlay in the corner, and try{" "}
            <code>rrd.explain("ProductTable")</code>.
          </span>
          <button onClick={() => setFixed((f) => !f)}>Show {fixed ? "broken" : "fixed"} version</button>
        </div>
        {fixed ? <FixedDashboard /> : <Dashboard />}
      </div>
    </SessionProvider>
  );
}
