import { Ornament, type OrnamentTabProps } from '@/components/core/ornament'
import { WindowControls } from '@/components/core/window-control'

const tabs: OrnamentTabProps[] = [
  {
    name: 'Create',
    href: '/openmarble',
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-6"
        data-slot="icon"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" x2="12" y1="3" y2="15" />
      </svg>
    ),
  },
]

export default function OpenMarbleLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="relative mx-auto flex w-full flex-col items-center justify-center">
      <Ornament
        tabs={tabs}
        className="max-w-5xl xl:max-w-[1400px] 2xl:max-w-[1600px]"
      >
        {children}
      </Ornament>
      <WindowControls />
    </div>
  )
}
