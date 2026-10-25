// A card's text area as one Client region: a click anywhere in it unfolds the
// card, and hovering shows that it would. Plain buttons only take clicks on
// their own text, and a button cannot wrap a whole card; a Client hears the
// pointer over its whole region. Drawn on the desktop surface; the pulse dots
// and "open" sit beside it, so a click there never also unfolds the card.
import type { ClientModule } from 'claude-code'

export type CardProps = {
  path: string
  id: string
  /** it just asked for you: opening it keeps it in place (the board's rule) */
  isFresh: boolean
  title: string
  meta: string
  needs: string
  accent: string
  isOpen: boolean
}

type Local = { isHover: boolean; isDown: boolean }

const CardText: ClientModule<CardProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ isHover: false, isDown: false })
    surface.onPointer(e => {
      const now = surface.state ?? { isHover: false, isDown: false }
      if (e.type === 'enter') surface.setState({ ...now, isHover: true })
      else if (e.type === 'leave') surface.setState({ isHover: false, isDown: false })
      else if (e.type === 'down' && e.button === 'left') surface.setState({ ...now, isDown: true })
      else if (e.type === 'up' && e.button === 'left' && now.isDown) {
        surface.setState({ ...now, isDown: false })
        // the board toggles the card: its open state is shared with the rest of the board
        surface.post({ kind: 'toggle', path: props.path, id: props.id, isFresh: props.isFresh })
      }
    })
  }
  const isHover = surface.state?.isHover ?? false
  return (
    <Box flexDirection="column">
      <Text bold underline={isHover}>{props.title}</Text>
      <Text dimColor>{props.meta}</Text>
      {/* hover only underlines the title: an added line made the cards jump */}
      {props.needs !== '' && <Text color={props.accent}>→ {props.needs}</Text>}
    </Box>
  )
}

export default CardText
