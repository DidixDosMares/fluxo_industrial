import dynamic from "next/dynamic";

const IndustrialFlowPanel = dynamic(
  () => import("@/components/IndustrialFlowPanel"),
  { ssr: false }
);

export default function Home() {
  return <IndustrialFlowPanel />;
}