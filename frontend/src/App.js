import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Show, SignIn, SignUp } from "@clerk/react";
import ClerkAuthProvider from "@/components/auth/ClerkAuthProvider";
import { Toaster } from "@/components/ui/sonner";
import { MeProvider } from "@/context/MeContext";
import Layout from "@/components/Layout";
import Landing from "@/pages/Landing";
import Dashboard from "@/pages/Dashboard";
import Interactions from "@/pages/Interactions";
import InteractionDetail from "@/pages/InteractionDetail";
import QAForms from "@/pages/QAForms";
import Coaching from "@/pages/Coaching";
import Knowledge from "@/pages/Knowledge";
import Article from "@/pages/Article";
import Trees from "@/pages/Trees";
import TreeRunner from "@/pages/TreeRunner";
import TreeEditor from "@/pages/TreeEditor";
import Training from "@/pages/Training";
import Course from "@/pages/Course";
import Users from "@/pages/Users";
import { CompanyLoginLink } from "@/pages/LdapLogin";
import Help from "@/pages/Help";
import Disputes from "@/pages/Disputes";
import Settings from "@/pages/Settings";
import LdapLogin from "@/pages/LdapLogin";
import { ldapToken } from "@/lib/api";

function Protected() {
  if (ldapToken()) return <MeProvider><Layout /></MeProvider>;
  return (
    <>
      <Show when="signed-in"><MeProvider><Layout /></MeProvider></Show>
      <Show when="signed-out"><Navigate to="/sign-in" replace /></Show>
    </>
  );
}

function Home() {
  if (ldapToken()) return <Navigate to="/dashboard" replace />;
  return (
    <>
      <Show when="signed-in"><Navigate to="/dashboard" replace /></Show>
      <Show when="signed-out"><Landing /></Show>
    </>
  );
}

const AuthPage = ({ children }) => <div className="grid-bg flex min-h-screen flex-col items-center justify-center gap-4 p-4">{children}</div>;

function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <ClerkAuthProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/sign-in/*" element={<AuthPage><SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" withSignUp /><CompanyLoginLink /></AuthPage>} />
            <Route path="/sign-up/*" element={<AuthPage><SignUp routing="path" path="/sign-up" signInUrl="/sign-in" /></AuthPage>} />
            <Route path="/ldap-login" element={<LdapLogin />} />
            <Route path="/help" element={<Help />} />
            <Route path="/help/:id" element={<Help />} />
            <Route element={<Protected />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/interactions" element={<Interactions />} />
              <Route path="/interactions/:id" element={<InteractionDetail />} />
              <Route path="/qa-forms" element={<QAForms />} />
              <Route path="/coaching" element={<Coaching />} />
              <Route path="/knowledge" element={<Knowledge />} />
              <Route path="/knowledge/:id" element={<Article />} />
              <Route path="/trees" element={<Trees />} />
              <Route path="/trees/:id" element={<TreeRunner />} />
              <Route path="/trees/:id/edit" element={<TreeEditor />} />
              <Route path="/training" element={<Training />} />
              <Route path="/training/:id" element={<Course />} />
              <Route path="/users" element={<Users />} />
              <Route path="/disputes" element={<Disputes />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<Outlet />} />
          </Routes>
        </ClerkAuthProvider>
      </BrowserRouter>
      <Toaster theme="light" richColors position="top-right" />
    </div>
  );
}

export default App;
