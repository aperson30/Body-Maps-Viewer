import dynamic from 'next/dynamic';

// NiiVue uses WebGL — must be client-side only
const CTViewer = dynamic(() => import('@/components/CTViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-[#0a0a0f] text-gray-400">
      <p>Loading viewer…</p>
    </div>
  ),
});

export default function Home() {
  return <CTViewer />;
}
